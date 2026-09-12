import {
  env,
  ICacheService,
  IStorageService,
  MemoryCacheService,
  RedisCacheService,
  S3StorageService,
} from "@hypertube/server-core";

export const container: {
  cacheService: ICacheService;
  storageService: IStorageService;
} = {
  cacheService:
    env.CACHE_DRIVER === "memory"
      ? new MemoryCacheService()
      : new RedisCacheService(),
  storageService: new S3StorageService(),
};
