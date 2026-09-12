import { registerCrons, S3StorageService } from "@hypertube/server-core";

const storageService = new S3StorageService();

registerCrons(storageService);
