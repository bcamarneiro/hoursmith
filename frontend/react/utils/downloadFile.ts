export function sanitizeFilename(filename: string): string {
	return filename
		.trim()
		.replace(/[/\\?%*:|"<>]/g, '-')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-');
}

function triggerDownload(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = sanitizeFilename(filename);
	anchor.style.display = 'none';
	document.body.appendChild(anchor);
	try {
		anchor.click();
	} finally {
		document.body.removeChild(anchor);
		URL.revokeObjectURL(url);
	}
}

export function downloadAsFile(
	content: string,
	filename: string,
	mimeType: string,
): void {
	triggerDownload(new Blob([content], { type: mimeType }), filename);
}

/** Download raw bytes (e.g. a generated `.xlsx`), not a text string. */
export function downloadBinaryFile(
	bytes: Uint8Array,
	filename: string,
	mimeType: string,
): void {
	// Copy into a fresh ArrayBuffer so the Blob never sees a SharedArrayBuffer-
	// backed view (Blob's BlobPart typing rejects those).
	const buffer = bytes.slice();
	triggerDownload(new Blob([buffer], { type: mimeType }), filename);
}
