import type { getSiteClient } from "./site-client.ts";

export type AccountProfile = { display_name: string; picture: string | null };
export const emptyProfile: AccountProfile = { display_name: "", picture: null };
export function profileStore(client: ReturnType<typeof getSiteClient>) {
  return {
    async load(userId: string) {
      const { data, error } = await client.from("account_profiles").select("display_name,picture")
        .eq("user_id", userId).maybeSingle();
      if (error) throw error;
      return data ?? emptyProfile;
    },
    async save(userId: string, changes: Partial<AccountProfile>) {
      const { data, error } = await client.from("account_profiles")
        .upsert({ user_id: userId, ...changes }, { defaultToNull: false })
        .select("display_name,picture").single();
      if (error) throw error;
      return data;
    }
  };
}
export type ProfileStore = ReturnType<typeof profileStore>;

// Re-encode a center crop so the profile stores a thumbnail without the original photo's metadata.
export async function makeThumbnail(file: File) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 16 * 1024 * 1024) {
    throw Error("Choose a JPEG, PNG or WebP picture under 16 MB.");
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 160;
    const ctx = canvas.getContext("2d");
    if (!ctx || !side) throw Error();
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 160, 160);
    ctx.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 160, 160);
    const jpeg = canvas.toDataURL("image/jpeg", 0.82);
    if (!jpeg.startsWith("data:image/jpeg;base64,") || jpeg.length > 65536) throw Error();
    return jpeg;
  } catch {
    throw Error("Unable to read this picture. Try a different image.");
  } finally {
    URL.revokeObjectURL(url);
  }
}
