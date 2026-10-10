export interface ImageRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}
export function validRegion(r: ImageRegion | undefined): r is ImageRegion {
  return (
    !!r &&
    [r.left, r.top, r.width, r.height].every(Number.isFinite) &&
    r.left >= 0 &&
    r.top >= 0 &&
    r.width > 0 &&
    r.height > 0 &&
    r.left + r.width <= 1.000001 &&
    r.top + r.height <= 1.000001
  );
}
export function slideImageKey(slide: {
  imageSource?: string;
  imageCrop?: ImageRegion;
}) {
  return slide.imageCrop
    ? `${slide.imageSource}:${JSON.stringify(slide.imageCrop)}`
    : slide.imageSource;
}
// Keep historical whole-page assets intact; prefer located figures for new work.
export function preferredSources<
  T extends {
    image?: string;
    imageRegion?: ImageRegion;
    page?: number;
    figure?: string;
    attachmentId?: string;
  },
>(sources: T[]): T[] {
  return sources.filter(
    (s) =>
      !s.image ||
      s.imageRegion ||
      s.attachmentId ||
      !sources.some(
        (other) =>
          other.imageRegion &&
          other.figure &&
          other.figure === s.figure &&
          other.page === s.page,
      ),
  );
}
export function cropPixels(r: ImageRegion, width: number, height: number) {
  const left = Math.floor(r.left * width),
    top = Math.floor(r.top * height);
  return {
    left,
    top,
    width: Math.min(width, Math.ceil((r.left + r.width) * width)) - left,
    height: Math.min(height, Math.ceil((r.top + r.height) * height)) - top,
  };
}
