type Document = {
	name: string;
	updateTime: string;
	fields: Record<string, { stringValue: string }>;
};
type Write = {
	update?: Omit<Document, 'updateTime'>;
	delete?: string;
	currentDocument?: { exists?: boolean; updateTime?: string };
};

// Minimal atomic Firestore REST emulator. No Google/Spotify credentials or network calls.
export function fakeFirestore() {
	const documents = new Map<string, Document>();
	const commits: Write[][] = [];
	let sequence = 0;
	const request: typeof fetch = async (input, init) => {
		const url = String(input);
		if (url.includes('/computeMetadata/')) return Response.json({ access_token: 'test-token' });
		if (url.endsWith('/documents:commit')) {
			const { writes } = JSON.parse(String(init?.body)) as { writes: Write[] };
			for (const w of writes) {
				const previous = documents.get(w.update?.name ?? w.delete!);
				if (
					(w.currentDocument?.exists === false && previous) ||
					(w.currentDocument?.updateTime && previous?.updateTime !== w.currentDocument.updateTime)
				)
					return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
			}
			commits.push(writes);
			const writeResults = writes.map((w) => {
				const updateTime = new Date(Date.now() + ++sequence).toISOString();
				if (w.delete) documents.delete(w.delete);
				else documents.set(w.update!.name, { ...w.update!, updateTime });
				return { updateTime };
			});
			return Response.json({ writeResults });
		}
		const name = url.replace('https://firestore.googleapis.com/v1/', '').split('?')[0];
		if (
			['episodes', 'catalogues', 'schedules'].some((collection) => name.endsWith('/' + collection))
		) {
			return Response.json({
				documents: [...documents.values()].filter(
					(d) => d.name.startsWith(name + '/') && !d.name.slice(name.length + 1).includes('/')
				)
			});
		}
		return documents.has(name)
			? Response.json(documents.get(name))
			: new Response(null, { status: 404 });
	};
	return { request, documents, commits };
}
