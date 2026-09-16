import { UserImageAvatar } from "@/components/images/Avatar";
import { LoadingButton } from "@/components/LoadingButton";
import { Input } from "@/components/ui/input";
import { useRequiredUser } from "@/hooks/use-required-user";
import { axiosFetch } from "@/lib/fetch/axiosFetch";
import { getQueryKey } from "@/lib/getQueryKey";
import {
  deleteImageSchemas,
  getUrl,
  patchUsersSchemas,
  postImageSchemas,
  ROUTES,
  sizeMaxFile,
} from "@hypertube/libs";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import z from "zod";

const formatMB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export const ProfilePictureUpdate = () => {
  const user = useRequiredUser();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const { mutate: updateMutate } = useMutation({
    mutationFn: async (file: File | undefined) => {
      if (!file) return;
      const formData = new FormData();
      formData.append("file", file);

      const image = await axiosFetch({
        method: "POST",
        url: getUrl(ROUTES.API.IMAGES),
        schemas: {
          requirements: z.instanceof(FormData),
          response: postImageSchemas.response,
        },
        data: formData,
        config: { headers: { "Content-Type": "multipart/form-data" } },
      });

      if (user.imageId) {
        await axiosFetch({
          method: "DELETE",
          url: getUrl(ROUTES.API.IMAGES, { imageId: user.imageId }),
          schemas: deleteImageSchemas,
        });
      }

      await axiosFetch({
        method: "PATCH",
        url: getUrl(ROUTES.API.USERS, { userId: user.id }),
        schemas: patchUsersSchemas,
        data: { imageId: image.id },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: getQueryKey(ROUTES.API.USERS_SESSION),
      });
      toast.success(t("settings.updatePicture"));
    },
    onError: (_error, file) => {
      if (file && file.size > sizeMaxFile) {
        toast.error(
          t("settings.updatePictureTooLarge", {
            size: formatMB(file.size),
            maxSize: formatMB(sizeMaxFile),
          })
        );
        return;
      }
      toast.error(t("settings.updatePictureFailed"));
    },
  });

  const {
    mutate: delMutate,
    isPending: isDelPending,
    isSuccess: isDelSuccess,
  } = useMutation({
    mutationFn: async () => {
      if (user.imageId)
        await axiosFetch({
          method: "DELETE",
          url: getUrl(ROUTES.API.IMAGES, { imageId: user.imageId }),
          schemas: deleteImageSchemas,
        });

      await axiosFetch({
        method: "PATCH",
        url: getUrl(ROUTES.API.USERS, { userId: user.id }),
        schemas: patchUsersSchemas,
        data: { imageId: null },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: getQueryKey(ROUTES.API.USERS_SESSION),
      });
      toast.success(t("settings.updatePicture"));
    },
    onError: () => {
      toast.error(t("settings.updatePictureFailed"));
    },
  });

  return (
    <div className="flex flex-col items-center gap-2">
      <UserImageAvatar size="lg" />
      <Input
        type="file"
        className="w-full"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          if (file.size > sizeMaxFile) {
            toast.error(
              t("settings.updatePictureTooLarge", {
                size: formatMB(file.size),
                maxSize: formatMB(sizeMaxFile),
              })
            );
            return;
          }
          updateMutate(file);
        }}
      />
      <LoadingButton
        disabled={!user.image}
        type="button"
        className="w-full"
        loading={isDelPending}
        success={isDelSuccess}
        onClick={() => {
          delMutate();
        }}
      >
        {t("settings.deletePicture")}
      </LoadingButton>
    </div>
  );
};
