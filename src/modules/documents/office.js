export const officeFiles = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function officeMime(buffer) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) return null;
  // Inspect the ZIP directory without inflating member data.
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (
    end < 0 ||
    end + 22 > buffer.length ||
    end + 22 + buffer.readUInt16LE(end + 20) !== buffer.length ||
    buffer.readUInt16LE(end + 4) ||
    buffer.readUInt16LE(end + 6)
  )
    return null;
  const size = buffer.readUInt32LE(end + 12);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  if (
    count !== buffer.readUInt16LE(end + 8) ||
    !count ||
    count > 2000 ||
    offset + size !== end
  )
    return null;
  const names = new Set();
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50)
      return null;
    const flags = buffer.readUInt16LE(offset + 8);
    const compression = buffer.readUInt16LE(offset + 10);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 46;
    const header = buffer.readUInt32LE(offset + 42);
    expanded += buffer.readUInt32LE(offset + 24);
    if (
      flags & 1 ||
      ![0, 8].includes(compression) ||
      header + 30 > offset ||
      buffer.readUInt32LE(header) !== 0x04034b50 ||
      expanded > 64 * 1024 * 1024
    )
      return null;
    offset =
      nameStart +
      nameLength +
      buffer.readUInt16LE(offset + 30) +
      buffer.readUInt16LE(offset + 32);
    if (!nameLength || offset > end) return null;
    const name = buffer
      .subarray(nameStart, nameStart + nameLength)
      .toString("utf8");
    if (
      name.includes("\\") ||
      name.startsWith("/") ||
      name.split("/").includes("..") ||
      /(?:vbaProject|\/activeX\/|\/embeddings\/)/i.test(name) ||
      names.has(name)
    )
      return null;
    names.add(name);
  }
  if (
    offset !== end ||
    !names.has("[Content_Types].xml") ||
    !names.has("_rels/.rels")
  )
    return null;
  const word = names.has("word/document.xml");
  const excel = names.has("xl/workbook.xml");
  if (word === excel) return null;
  return word ? officeFiles.docx : officeFiles.xlsx;
}
