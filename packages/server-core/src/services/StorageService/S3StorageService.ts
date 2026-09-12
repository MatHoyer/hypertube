import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";
import { env } from "../../env.js";
import { IStorageService } from "./IStorageService.js";

const REMOVE_BATCH = 1000;
const DEFAULT_PRESIGNED_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

const s3Client = new S3Client({
  endpoint: `${env.S3_USE_SSL ? "https" : "http"}://${env.S3_ENDPOINT}${
    env.S3_PORT ? `:${env.S3_PORT}` : ""
  }`,
  region: "us-east-1",
  credentials: {
    accessKeyId: env.S3_ROOT_USER,
    secretAccessKey: env.S3_ROOT_PASSWORD,
  },
  forcePathStyle: true,
});

export class S3StorageService implements IStorageService {
  s3Client: S3Client;

  constructor() {
    this.s3Client = s3Client;
  }

  getObject: IStorageService["getObject"] = async (bucketName, objectName) => {
    const { Body } = await this.s3Client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: objectName })
    );
    return Body as Readable;
  };

  statObject: IStorageService["statObject"] = async (
    bucketName,
    objectName
  ) => {
    const res = await this.s3Client.send(
      new HeadObjectCommand({ Bucket: bucketName, Key: objectName })
    );
    const metaData: Record<string, string | number> = {
      ...(res.Metadata ?? {}),
    };
    if (res.ContentType) metaData["content-type"] = res.ContentType;
    return { metaData, size: res.ContentLength ?? 0 };
  };

  getPartialObject: IStorageService["getPartialObject"] = async (
    bucketName,
    objectName,
    offset,
    length
  ) => {
    const range =
      length !== undefined
        ? `bytes=${offset}-${offset + length - 1}`
        : `bytes=${offset}-`;
    const { Body } = await this.s3Client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: objectName, Range: range })
    );
    return Body as Readable;
  };

  putObject: IStorageService["putObject"] = async (
    bucketName,
    objectName,
    stream,
    size,
    metaData
  ) => {
    const { "Content-Type": contentType, ...customMetaData } =
      metaData ?? ({} as Record<string, string | number>);

    const stringMetaData = Object.fromEntries(
      Object.entries(customMetaData).map(([key, value]) => [key, String(value)])
    );

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: objectName,
        Body: stream,
        ContentLength: size,
        ContentType: contentType !== undefined ? String(contentType) : undefined,
        Metadata: Object.keys(stringMetaData).length ? stringMetaData : undefined,
      })
    );
  };

  removeObject: IStorageService["removeObject"] = async (
    bucketName,
    objectName
  ) => {
    await this.s3Client.send(
      new DeleteObjectCommand({ Bucket: bucketName, Key: objectName })
    );
  };

  removeObjectsByPrefix: IStorageService["removeObjectsByPrefix"] = async (
    bucketName,
    prefix
  ) => {
    const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
    const names: string[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: normalized,
          ContinuationToken: continuationToken,
        })
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) names.push(obj.Key);
      }
      continuationToken = res.NextContinuationToken;
    } while (continuationToken);

    if (names.length === 0) return;
    for (let i = 0; i < names.length; i += REMOVE_BATCH) {
      const chunk = names.slice(i, i + REMOVE_BATCH);
      await this.s3Client.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: { Objects: chunk.map((Key) => ({ Key })) },
        })
      );
    }
  };

  presignedGetObject: IStorageService["presignedGetObject"] = async (
    bucketName,
    objectName,
    expirySeconds
  ) => {
    return await getSignedUrl(
      this.s3Client,
      new GetObjectCommand({ Bucket: bucketName, Key: objectName }),
      { expiresIn: expirySeconds ?? DEFAULT_PRESIGNED_EXPIRY_SECONDS }
    );
  };
}
