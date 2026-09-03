export type SmartId = 'inbox' | 'pinned' | 'unread' | 'recent' | 'archived';

/** Grid record ordering, applied after filter + search. */
export type GridSort = 'newest' | 'oldest' | 'title' | 'domain';

export type Filter =
	| { kind: 'all' }
	| { kind: 'collection'; path: string }
	| { kind: 'smart'; id: SmartId }
	| { kind: 'tag'; tag: string };

export interface BookmarkRecord {
	path: string;
	url: string;
	title: string;
	collection: string;
	tags: string[];
	status: 'unread' | 'read';
	pinned: boolean;
	created: string;
	cover?: string;
	favicon?: string;
	readable?: string;
	description?: string;
	wayback?: string;
}

export const VIEW_TYPE_TREE = 'linkhaven-tree';
export const VIEW_TYPE_GRID = 'linkhaven-grid';

/** Custom drag-and-drop mime type carrying a JSON array of selected bookmark paths. */
export const LH_BULK_MIME = 'application/x-lh-bookmarks';

/** Input accepted when creating a bookmark note. */
export interface NewBookmarkInput {
	url: string;
	title?: string;
	collection?: string;
	tags?: string[];
	description?: string;
	created?: string;
	pinned?: boolean;
}
