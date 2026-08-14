export const CANVAS_AUTOSAVE_DELAY_MS = 800;

const DEFAULT_ELEMENT_TITLES = {
  text_box: '文字框',
  image: '圖片',
  video: '影片',
  shape: '圖形',
};

export function buildCanvasElementPayload(element, index, lessonId) {
  const positionData = {
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    opacity: element.opacity ?? 1,
    locked: element.locked ?? false,
  };

  if (element.type === 'shape') {
    positionData.shapeType = element.shapeType;
    positionData.fillColor = element.fillColor;
    positionData.borderColor = element.borderColor;
    positionData.borderWidth = element.borderWidth;
    positionData.borderRadius = element.borderRadius;
    if (element.linkUrl) positionData.linkUrl = element.linkUrl;
    if (element.shapeType === 'button') {
      positionData.textColor = element.textColor || '#ffffff';
    }
  }

  const dbType = element.type === 'text_box'
    ? 'article'
    : element.type === 'image'
      ? 'image_text'
      : element.type === 'shape'
        ? 'article'
        : element.type;

  return {
    lesson_id: lessonId,
    type: dbType,
    title: element.title || DEFAULT_ELEMENT_TITLES[element.type] || '元素',
    body: element.body || '',
    video_url: element.type === 'image'
      ? (element.storagePath || null)
      : (element.videoUrl || null),
    order: index,
    status: 'draft',
    position_data: positionData,
  };
}

export function getCanvasElementSaveFingerprint(element, index, lessonId) {
  return JSON.stringify(buildCanvasElementPayload(element, index, lessonId));
}

export function createCanvasSavedFingerprints(elements, lessonId) {
  return new Map(elements.map((element, index) => [
    element.id,
    getCanvasElementSaveFingerprint(element, index, lessonId),
  ]));
}

export function getDirtyCanvasElements(elements, savedFingerprints, lessonId) {
  return elements.flatMap((element, index) => {
    const fingerprint = getCanvasElementSaveFingerprint(element, index, lessonId);
    return savedFingerprints.get(element.id) === fingerprint
      ? []
      : [{ element, index, fingerprint }];
  });
}
