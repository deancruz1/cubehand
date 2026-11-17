// Pictures a tool hands back: { ok, message, images: [{ media_type, data, label }] }, with data
// in base64. They go to the model inside the tool's result, and nowhere else keeps the data.

// The conversation is only ever added to (editing an earlier turn would make the thinking after
// it invalid), so pictures can't be taken out again. Instead only this many results in a job
// carry theirs.
export const MAX_PICTURE_RESULTS = 12;
export const PICTURE_LIMIT = `(No pictures with this one: this job has reached its limit of ${MAX_PICTURE_RESULTS} results with pictures. A new request starts a fresh count.)`;

export const hasPictures = (images) => Array.isArray(images) && images.length > 0;

// The content of a tool_result: the text alone, or the text first and then each picture after a
// line with its label.
export function toolContent(text, images) {
  if (!hasPictures(images)) return text;
  const blocks = [{ type: 'text', text }];
  images.forEach((image, i) => {
    blocks.push({ type: 'text', text: `Picture ${i + 1}: ${image.label ?? 'no label'}` });
    blocks.push({ type: 'image', source: { type: 'base64', media_type: image.media_type ?? 'image/png', data: image.data } });
  });
  return blocks;
}

// For the job log: how many pictures and their labels, never the data.
export function picturesNote(images) {
  return hasPictures(images) ? { images: { count: images.length, labels: images.map((i) => String(i.label ?? '')) } } : {};
}

export const picturesText = (images) => (hasPictures(images) ? ` (+${images.length} picture${images.length === 1 ? '' : 's'}: ${images.map((i) => i.label ?? 'no label').join(', ')})` : '');

// A copy of messages with each picture's data left out, for logs that keep the whole request.
export function withoutPictureData(messages) {
  const strip = (content) =>
    Array.isArray(content)
      ? content.map((b) => {
          if (b?.type === 'image' && b.source?.type === 'base64') return { ...b, source: { type: 'base64', media_type: b.source.media_type, data: `(${b.source.data?.length ?? 0} base64 characters left out)` } };
          if (b?.type === 'tool_result') return { ...b, content: strip(b.content) };
          return b;
        })
      : content;
  return messages.map((m) => ({ ...m, content: strip(m.content) }));
}
