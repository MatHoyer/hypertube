import {
  ICacheService,
  IStorageService,
  RedisCacheService,
  S3StorageService,
} from "@hypertube/server-core";

export const container: {
  cacheService: ICacheService;
  storageService: IStorageService;
} = {
  cacheService: new RedisCacheService(),
  storageService: new S3StorageService(),
};
