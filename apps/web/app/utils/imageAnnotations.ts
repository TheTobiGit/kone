export type AnnotationTool = "pen" | "arrow" | "rectangle";
export type ImagePoint = { x: number; y: number };
export type ImageAnnotation = {
  tool: AnnotationTool;
  color: string;
  width: number;
  points: ImagePoint[];
};

/** Image coordinates keep marks aligned at every preview size and at export. */
export function imagePoint(
  x: number,
  y: number,
  bounds: { left: number; top: number; width: number; height: number },
  image: { width: number; height: number },
): ImagePoint {
  return {
    x: Math.max(0, Math.min(image.width, (x - bounds.left) * image.width / bounds.width)),
    y: Math.max(0, Math.min(image.height, (y - bounds.top) * image.height / bounds.height)),
  };
}

export function annotationPath(mark: ImageAnnotation): string {
  const start = mark.points[0];
  const end = mark.points.at(-1);
  if (!start || !end) return "";
  if (mark.tool === "pen") {
    // A single click still leaves a round dot with a round line cap.
    if (mark.points.length === 1) return `M${start.x},${start.y} l0.01,0`;
    return mark.points.map((point, i) => `${i ? "L" : "M"}${point.x},${point.y}`).join(" ");
  }
  if (mark.tool === "rectangle") {
    return `M${start.x},${start.y} H${end.x} V${end.y} H${start.x} Z`;
  }
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const head = Math.min(Math.hypot(end.x - start.x, end.y - start.y) / 2, mark.width * 5);
  const wing = Math.PI / 6;
  return `M${start.x},${start.y} L${end.x},${end.y} M${end.x - head * Math.cos(angle - wing)},${end.y - head * Math.sin(angle - wing)} L${end.x},${end.y} L${end.x - head * Math.cos(angle + wing)},${end.y - head * Math.sin(angle + wing)}`;
}

export async function annotatedImageFile(
  image: HTMLImageElement,
  marks: readonly ImageAnnotation[],
  name: string,
): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image editing is unavailable. Please try again.");
  context.drawImage(image, 0, 0);
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const mark of marks) {
    context.strokeStyle = mark.color;
    context.lineWidth = mark.width;
    context.stroke(new Path2D(annotationPath(mark)));
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Could not save this image. Try a smaller image.")), "image/png");
  });
  const stem = name.replace(/\.[^.]+$/, "");
  return new File([blob], `${stem}.png`, { type: "image/png" });
}
