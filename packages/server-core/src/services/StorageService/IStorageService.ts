import { Readable } from "stream";
import { TBuckets } from "./const.js";

export interface IStorageService {
  getObject: (bucketName: TBuckets, objectName: string) => Promise<Readable>;
  statObject: (
    bucketName: TBuckets,
    objectName: string
  ) => Promise<{ metaData: Record<string, string | number>; size: number }>;
  getPartialObject: (
    bucketName: TBuckets,
    objectName: string,
    offset: number,
    length?: number
  ) => Promise<Readable>;
  putObject: (
    bucketName: TBuckets,
    objectName: string,
    stream: string | Readable | Buffer<ArrayBufferLike>,
    size?: number,
    metaData?: Record<string, string | number>
  ) => Promise<void>;
  removeObject: (bucketName: TBuckets, objectName: string) => Promise<void>;
  removeObjectsByPrefix: (bucketName: TBuckets, prefix: string) => void;
  listObjectNamesByPrefix: (
    bucketName: TBuckets,
    prefix: string
  ) => Promise<string[]>;
  presignedGetObject: (
    bucketName: TBuckets,
    objectName: string,
    expirySeconds?: number
  ) => Promise<string>;
}
