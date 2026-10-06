export type CropPoint = { x: number; y: number };
export type PdfCrop = {
  left: number;
  top: number;
  width: number;
  height: number;
};
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function cropFromPoints(start: CropPoint, end: CropPoint): PdfCrop {
  const left = Math.min(clamp(start.x), clamp(end.x));
  const top = Math.min(clamp(start.y), clamp(end.y));
  return {
    left,
    top,
    width: Math.abs(clamp(start.x) - clamp(end.x)),
    height: Math.abs(clamp(start.y) - clamp(end.y)),
  };
}

export function cropPixels(crop: PdfCrop, width: number, height: number) {
  if (
    !crop ||
    ![crop.left, crop.top, crop.width, crop.height, width, height].every(
      Number.isFinite,
    ) ||
    crop.left < 0 ||
    crop.left >= 1 ||
    crop.top < 0 ||
    crop.top >= 1 ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.left + crop.width > 1.000001 ||
    crop.top + crop.height > 1.000001 ||
    width < 1 ||
    height < 1
  )
    return undefined;
  const floor = (value: number) => Math.floor(value + 1e-9);
  const ceil = (value: number) => Math.ceil(value - 1e-9);
  const left = floor(crop.left * width);
  const top = floor(crop.top * height);
  const result = {
    left,
    top,
    width: Math.min(ceil(width), ceil((crop.left + crop.width) * width)) - left,
    height:
      Math.min(ceil(height), ceil((crop.top + crop.height) * height)) - top,
  };
  return result.width > 0 && result.height > 0 ? result : undefined;
}
