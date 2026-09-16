import {
  deleteImageSchemas,
  postImageSchemas,
  sizeMaxFile,
} from "@hypertube/libs";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { bodyParser } from "../../middlewares/bodyParser";
import { TApiContext } from "../../middlewares/injectApiContext";
import { isLogged } from "../../middlewares/isLogged";
import { urlParamsParser } from "../../middlewares/urlParamsParser";
import { deleteImage, postImage } from "./images.controller";

const imagesRouter = new Hono<TApiContext>();

imagesRouter.post(
  "/",
  isLogged,
  bodyLimit({
    maxSize: sizeMaxFile,
    onError: (c) => {
      return c.json({ message: "File too large" }, 413);
    },
  }),
  bodyParser(postImageSchemas.requirements, "formData"),
  postImage
);

imagesRouter.delete(
  "/:imageId",
  isLogged,
  urlParamsParser(deleteImageSchemas.urlParams),
  deleteImage
);

export default imagesRouter;
