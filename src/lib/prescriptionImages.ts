export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGES_PER_PRESCRIPTION = 3;
// Base64 is a third bigger than the bytes it carries.
export const IMAGE_BODY_LIMIT = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4096;

export type ImageType = "image/jpeg" | "image/png" | "image/webp";

// Reads the first bytes, not the name or the declared type, so a renamed file is caught.
export function detectImageType(buf: Buffer): ImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

// Why an upload cannot be stored, or the bytes and detected type.
export function imageProblem(dataBase64: string, declared: string, existingCount: number): { problem: string } | { bytes: Buffer; type: ImageType } {
  if (existingCount >= MAX_IMAGES_PER_PRESCRIPTION) return { problem: `A prescription can have ${MAX_IMAGES_PER_PRESCRIPTION} photos at most.` };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) return { problem: "The photo data is not valid." };
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.length === 0) return { problem: "The photo is empty." };
  if (bytes.length > MAX_IMAGE_BYTES) return { problem: "The photo is larger than 4 MB. Take it again at a lower quality." };
  const type = detectImageType(bytes);
  if (!type) return { problem: "Only JPEG, PNG or WebP photos are accepted." };
  if (type !== declared) return { problem: "The photo type does not match its content." };
  return { bytes, type };
}
