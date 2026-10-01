import { ApiError } from './service.js';
export type Media = { mimetype: 'application/pdf' | 'image/png'; data: string; filename: string; caption: string };
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
export function validateMedia(value: unknown): Media {
    const media = value as Partial<Media> | null;
    if (!media || !['application/pdf', 'image/png'].includes(media.mimetype ?? '') || typeof media.data !== 'string' || !media.data.length || media.data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 || /[^A-Za-z0-9+/=]/.test(media.data) || typeof media.filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(media.filename) || media.filename.includes('..') || typeof media.caption !== 'string' || [...media.caption].length > 1024) {
        throw new ApiError(422, 'INVALID_INPUT', 'Provide a PDF or PNG attachment up to 8 MiB with a safe filename and caption up to 1024 characters.');
    }
    const bytes = Buffer.from(media.data, 'base64');
    const png = media.mimetype === 'image/png';
    const valid = png ? bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.subarray(12,16).toString() === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(16) * bytes.readUInt32BE(20) <= 16000000 : bytes.subarray(0,5).toString() === '%PDF-';
    if (!valid || bytes.length > MAX_MEDIA_BYTES || bytes.toString('base64') !== media.data || !media.filename.endsWith(png ? '.png' : '.pdf')) {
        throw new ApiError(422, 'INVALID_INPUT', 'Attachment content does not match the declared file type or size limits.');
    }
    return media as Media;
}
