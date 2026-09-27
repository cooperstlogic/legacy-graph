import {
    useState, useEffect, useEffectEvent, useRef, useCallback,
} from 'react';
import { useNavigate, useSearch as useRouterSearch, Link, useBlocker } from '@tanstack/react-router';
import { useStory, useCreateStory, useUpdateStory, useUploadStoryMedia, useDeleteStoryMedia, useDeleteStory } from '@/shared/api/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { storiesApi } from '@/shared/api/stories';
import {
    Dialog, DialogContent, DialogHeader, DialogTitle,
    DialogDescription, DialogFooter,
} from '@/shared/ui/dialog';
import { PersonChip } from '@/shared/components/PersonChip';
import { MilkdownEditor, type MilkdownEditorHandle } from '@/shared/components/MilkdownEditor';
import { SmartDateInput, parseToISO } from '@/shared/components/SmartDateInput';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { Skeleton } from '@/shared/ui/skeleton';
import {
    Pencil, Save, ArrowLeft, MapPin, CalendarDays,
    X, Lock, Unlock, ChevronLeft, ChevronRight, Star, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import type { UpdateStoryInput, FullStory } from '@/shared/api/stories';
import type { Place } from '@/shared/api/people';
import { formatPlaceDisplay, formatCoordinates } from '@/shared/lib/places';
import { PlaceSearchCombobox as PlaceSearchComboboxBase } from '@/shared/components/PlaceSearchCombobox';
import { PageShell } from '@/shared/components/layout/PageShell';

// ── Types ───────────────────────────────────────────────────────────────────

interface FrontmatterState {
    title: string;
    date: string;
    place: Place | undefined;
    isPrivate: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Extract person IDs from @N_xxx and [[N_xxx]] patterns in markdown content. */
function extractMentionIds(content: string): string[] {
    const ids = new Set<string>();
    const regex = /(?:@|(?:\[\[))(N_[a-zA-Z0-9_-]+)(?:\]\])?/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
        ids.add(m[1]);
    }
    return Array.from(ids);
}

// Story-specific wrapper: adds MapPin icon layout
function PlaceSearchCombobox({ value, onChange, onSelect, initialPlace }: { value: string; onChange: (name: string) => void; onSelect?: (place: Place) => void; initialPlace?: Place | null }) {
    return (
        <div className="flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <PlaceSearchComboboxBase
                value={value}
                onChange={onChange}
                onSelect={onSelect}
                initialPlace={initialPlace}
                debounceMs={200}
                placeholder="Place (city, country…)"
                inputClassName="h-7 text-sm w-56 border-muted"
                dropdownClassName="w-64"
                size="sm"
            />
        </div>
    );
}

// ── Main page ────────────────────────────────────────────────────────────────

export function StoryDetailPage({ id }: { id: string }) {
    const routerSearch = useRouterSearch({ strict: false }) as { mode?: string; person?: string };
    const navigate = useNavigate();

    const isNew = id === 'new';
    const isEditMode = isNew || routerSearch.mode === 'edit';

    const { data: story, isLoading, isError } = useStory(id);
    const createStory = useCreateStory();
    const updateStory = useUpdateStory();
    const deleteStory = useDeleteStory();
    const uploadMedia = useUploadStoryMedia();

    const queryClient = useQueryClient();
    const deleteStoryMedia = useDeleteStoryMedia();
    const [deleteAssetTarget, setDeleteAssetTarget] = useState<string | null>(null);
    const [lightboxAsset, setLightboxAsset] = useState<string | null>(null);

    const handleDeleteAsset = useCallback(async () => {
        if (!deleteAssetTarget) return;
        const filename = deleteAssetTarget;
        setDeleteAssetTarget(null);
        if (lightboxAsset === filename) setLightboxAsset(null);

        // Optimistically remove the asset from the cached story so the filmstrip
        // updates immediately without waiting for a refetch.
        queryClient.setQueryData(['story', id], (old: FullStory | undefined) => {
            if (!old) return old;
            return { ...old, metadata: { ...old.metadata, assets: (old.metadata.assets ?? []).filter((a: string) => a !== filename) } };
        });

        try {
            await deleteStoryMedia.mutateAsync({ id, filename });

            // Strip any inline image references to the deleted asset from the body.
            // Milkdown serializes images as ![caption](/assets/filename).
            const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const imagePattern = new RegExp(`!\\[[^\\]]*\\]\\(/assets/${escapedFilename}\\)\\n?`, 'g');
            const cleaned = contentRef2.current.replace(imagePattern, '').replace(/\n{3,}/g, '\n\n').trim();
            if (cleaned !== contentRef2.current) {
                setContent(cleaned);
                setIsDirty(true);
                setEditorResetKey((k) => k + 1);
                await updateStory.mutateAsync({ id, data: { content: cleaned } });
            }
            toast.success('Asset deleted');
        } catch {
            // Roll back the optimistic update on failure
            queryClient.invalidateQueries({ queryKey: ['story', id] });
            toast.error('Failed to delete asset');
        }
    }, [deleteAssetTarget, deleteStoryMedia, updateStory, queryClient, id, lightboxAsset]);

    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    const handleDelete = useCallback(async () => {
        setShowDeleteConfirm(false);
        try {
            await deleteStory.mutateAsync(id);
            toast.success('Story deleted');
            allowNavigationRef.current = true;
            navigate({ to: '/stories' });
        } catch {
            toast.error('Failed to delete story');
        }
    }, [deleteStory, id, navigate]);

    // Frontmatter state
    const [fm, setFm] = useState<FrontmatterState>({
        title: '',
        date: '',
        place: undefined,
        isPrivate: false,
    });

    // Editor content (raw Markdown)
    // When launched from a person page via ?person=N_xxx, seed the draft with a mention.
    const [content, setContent] = useState(() =>
        isNew && routerSearch.person ? `@${routerSearch.person} ` : ''
    );
    // Pre-seeded content (from ?person=) counts as unsaved from the start
    const [isDirty, setIsDirty] = useState(() => !!(isNew && routerSearch.person));
    const [isSaving, setIsSaving] = useState(false);

    const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const editorRef = useRef<MilkdownEditorHandle>(null);

    // When uploading images on a new (unsaved) story, or when auto-saving a new
    // story for the first time, we silently create it to get an ID.
    const silentlyCreatedIdRef = useRef<string | null>(null);
    // True only when user explicitly clicked Save/Create — prevents cleanup on unmount.
    const userExplicitlySavedRef = useRef(false);
    // Set to true immediately before any intentional navigate() call to suppress the
    // navigation blocker (e.g. after save, or after toolbar-initiated discard).
    const allowNavigationRef = useRef(false);
    // Snapshot of content+fm at the moment edit mode was entered (for Discard).
    const snapRef = useRef<{ content: string; fm: FrontmatterState } | null>(null);

    // Confirmation dialog for Discard / back-button navigation in edit mode
    const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
    // Incrementing this key forces the editor to remount after Discard resets content
    const [editorResetKey, setEditorResetKey] = useState(0);

    // Take a snapshot when first entering edit mode for an existing story.
    // The guard prevents re-snapshotting after auto-save updates the cache.
    useEffect(() => {
        if (!isEditMode || isNew || !story || snapRef.current) return;
        snapRef.current = {
            content: story.content ?? '',
            fm: {
                title: story.metadata.title ?? '',
                date: story.metadata.date ?? '',
                place: story.metadata.place,
                isPrivate: story.metadata.private ?? false,
            },
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isEditMode, isNew, story?.id]);

    // Clear snapshot when leaving edit mode (so the next edit session gets a fresh one)
    useEffect(() => {
        if (!isEditMode) snapRef.current = null;
    }, [isEditMode]);

    // ── Navigation guard ──────────────────────────────────────────────────────
    // Block all router navigation (sidebar, back, programmatic) when there are
    // unsaved edits. allowNavigationRef bypasses the guard for intentional saves/discards.

    const blocker = useBlocker({
        shouldBlockFn: useCallback(() => {
            if (allowNavigationRef.current) return false;
            return isEditMode && (isDirty || !!silentlyCreatedIdRef.current);
        }, [isEditMode, isDirty]),
        withResolver: true,
        enableBeforeUnload: true,
    });

    // Surface the existing discard dialog whenever the blocker intercepts navigation
    useEffect(() => {
        if (blocker.status === 'blocked') setShowDiscardConfirm(true);
    }, [blocker.status]);

    // On unmount: if a draft was auto-created but never explicitly saved, delete it + its assets.
    useEffect(() => {
        return () => {
            const draftId = silentlyCreatedIdRef.current;
            if (!draftId || userExplicitlySavedRef.current) return;
            // Fire-and-forget: purge uploaded assets then delete the draft story
            storiesApi.getStory(draftId)
                .then((s) => Promise.allSettled(
                    (s.metadata.assets ?? []).map((a) => storiesApi.deleteStoryMedia(draftId, a))
                ))
                .catch(() => {})
                .finally(() => storiesApi.deleteStory(draftId).catch(() => {}));
        };
    }, []); // Intentionally empty: runs only on unmount. storiesApi is a stable module singleton; refs are stable.
    // Latest fm/content for async callbacks that read them after an await.
    const fmRef = useRef(fm);
    const contentRef2 = useRef(content);
    useEffect(() => {
        fmRef.current = fm;
        contentRef2.current = content;
    }, [fm, content]);

    // Sync story data → local state on load
    // In edit mode, skip content/dirty reset so in-progress edits aren't clobbered
    // (e.g. after auto-save triggers a cache update). An effect event, so toggling
    // edit mode doesn't itself re-sync.
    const syncFromStory = useEffectEvent((loaded: NonNullable<typeof story>) => {
        setFm({
            title: loaded.metadata.title ?? '',
            date: loaded.metadata.date ?? '',
            place: loaded.metadata.place,
            isPrivate: loaded.metadata.private ?? false,
        });
        if (!isEditMode) {
            setContent(loaded.content ?? '');
            setIsDirty(false);
        }
    });
    useEffect(() => {
        if (story) syncFromStory(story);
    }, [story]);

    // Auto-save (3s debounce) while in edit mode — covers both new and existing stories.
    // New stories require a title before the first auto-save creates the draft.
    useEffect(() => {
        if (!isEditMode || !isDirty) return;
        if (isNew && !fm.title.trim()) return;
        if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
        autoSaveTimer.current = setTimeout(async () => {
            await doSave(false);
        }, 3000);
        return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [content, fm, isDirty]);

    const doSave = async (navigateAfter = true) => {
        if (!fm.title.trim()) { toast.error('Title is required'); return; }
        if (fm.date && !parseToISO(fm.date)) {
            toast.error('Invalid date — try "15 Jun 1944" or "1944-06-15"');
            return;
        }
        setIsSaving(true);
        try {
            // `content` trails the editor by Milkdown's onChange debounce
            const latestContent = editorRef.current?.getMarkdown() ?? content;
            const mentionedPeople = extractMentionIds(latestContent);
            const isoDate = parseToISO(fm.date) || undefined;
            const payload: UpdateStoryInput = {
                title: fm.title,
                content: latestContent,
                date: isoDate,
                place: fm.place || undefined,
                people: mentionedPeople,
                private: fm.isPrivate,
            };
            if (isNew && silentlyCreatedIdRef.current) {
                const createdId = silentlyCreatedIdRef.current;
                await updateStory.mutateAsync({ id: createdId, data: payload });
                setIsDirty(false);
                if (navigateAfter) {
                    toast.success('Story created');
                    userExplicitlySavedRef.current = true;
                    allowNavigationRef.current = true;
                    navigate({ to: '/stories/$id', params: { id: createdId } });
                }
            } else if (isNew) {
                const created = await createStory.mutateAsync({ ...payload, title: fm.title });
                silentlyCreatedIdRef.current = created.id;
                setIsDirty(false);
                if (navigateAfter) {
                    toast.success('Story created');
                    userExplicitlySavedRef.current = true;
                    allowNavigationRef.current = true;
                    navigate({ to: '/stories/$id', params: { id: created.id } });
                }
            } else {
                await updateStory.mutateAsync({ id, data: payload });
                setIsDirty(false);
                if (navigateAfter) {
                    userExplicitlySavedRef.current = true;
                    allowNavigationRef.current = true;
                    navigate({ to: '/stories/$id', params: { id }, search: {} });
                }
            }
        } catch {
            toast.error('Failed to save story');
        } finally {
            setIsSaving(false);
        }
    };

    // ── Discard ───────────────────────────────────────────────────────────────

    const handleDiscard = async () => {
        setShowDiscardConfirm(false);
        if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);

        // Was navigation blocked by the router, or was this triggered by the toolbar?
        // In the blocker case we call proceed() and the router takes the user to their
        // intended destination. In the toolbar case we navigate explicitly.
        const viaBlocker = blocker.status === 'blocked';

        if (isNew) {
            // Purge draft + its assets, then allow navigation
            const draftId = silentlyCreatedIdRef.current;
            if (draftId) {
                try {
                    const s = await storiesApi.getStory(draftId);
                    await Promise.allSettled(
                        (s.metadata.assets ?? []).map((a) => storiesApi.deleteStoryMedia(draftId, a))
                    );
                    await storiesApi.deleteStory(draftId);
                    silentlyCreatedIdRef.current = null;
                } catch { /* best-effort */ }
            }
            if (viaBlocker) {
                blocker.proceed?.();
            } else {
                allowNavigationRef.current = true;
                navigate({ to: '/stories' });
            }
        } else {
            // Revert server to the snapshot captured when entering edit mode
            const snap = snapRef.current;
            if (snap) {
                setIsSaving(true);
                try {
                    await updateStory.mutateAsync({
                        id,
                        data: {
                            title: snap.fm.title,
                            content: snap.content,
                            date: parseToISO(snap.fm.date) || undefined,
                            place: snap.fm.place || undefined,
                            people: extractMentionIds(snap.content),
                            private: snap.fm.isPrivate,
                        },
                    });
                } catch { /* ignore */ } finally {
                    setIsSaving(false);
                }
                setContent(snap.content);
                setFm(snap.fm);
            }
            setIsDirty(false);
            setEditorResetKey((k) => k + 1);
            snapRef.current = null;
            if (viaBlocker) {
                blocker.proceed?.();
            } else {
                allowNavigationRef.current = true;
                navigate({ to: '/stories/$id', params: { id }, search: {} });
            }
        }
    };

    // ── Image upload handler ──────────────────────────────────────────────────

    const handleImageUpload = useCallback(async (file: File): Promise<string> => {
        let targetId: string;

        if (isNew) {
            // Re-use a silently-created story if one already exists from a prior upload
            if (silentlyCreatedIdRef.current) {
                targetId = silentlyCreatedIdRef.current;
            } else {
                const currentFm = fmRef.current;
                if (!currentFm.title.trim()) {
                    toast.error('Add a title before uploading images');
                    throw new Error('No title');
                }
                // Auto-create the story so we have an ID to attach media to
                const isoDate = parseToISO(currentFm.date) || undefined;
                const created = await createStory.mutateAsync({
                    title: currentFm.title,
                    content: contentRef2.current,
                    date: isoDate,
                    place: currentFm.place || undefined,
                    people: extractMentionIds(contentRef2.current),
                    private: currentFm.isPrivate,
                });
                silentlyCreatedIdRef.current = created.id;
                targetId = created.id;
                toast.info('Uploading image — click Create to keep this story');
            }
        } else {
            targetId = id;
        }

        const updated = await uploadMedia.mutateAsync({ id: targetId, file });
        const asset = updated.metadata.assets[updated.metadata.assets.length - 1];
        return asset;
    }, [id, isNew, createStory, uploadMedia]);

    // ── Lightbox for filmstrip ────────────────────────────────────────────────

    useEffect(() => {
        if (!lightboxAsset) return;
        const currentAssets = story?.metadata.assets ?? [];
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { setLightboxAsset(null); return; }
            if (currentAssets.length <= 1) return;
            const idx = currentAssets.indexOf(lightboxAsset);
            if (e.key === 'ArrowLeft') setLightboxAsset(currentAssets[(idx - 1 + currentAssets.length) % currentAssets.length]);
            if (e.key === 'ArrowRight') setLightboxAsset(currentAssets[(idx + 1) % currentAssets.length]);
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [lightboxAsset, story?.metadata.assets]);

    // Set an asset as cover (first in the assets array)
    const handleSetCover = useCallback(async (filename: string) => {
        const currentAssets = story?.metadata.assets ?? [];
        if (currentAssets[0] === filename) return;
        const reordered = [filename, ...currentAssets.filter((a) => a !== filename)];
        try {
            await updateStory.mutateAsync({ id: isNew ? (silentlyCreatedIdRef.current ?? id) : id, data: { assets: reordered } });
            toast.success('Cover image updated');
        } catch {
            toast.error('Failed to update cover image');
        }
    }, [story?.metadata.assets, updateStory, id, isNew]);

    // ── Mention click handler ─────────────────────────────────────────────────

    const handleMentionClick = useCallback((personId: string) => {
        navigate({ to: '/people/$id', params: { id: personId } });
    }, [navigate]);

    // ── Loading / error ───────────────────────────────────────────────────────

    if (!isNew && isLoading) {
        return (
            <div className="p-8 space-y-4 max-w-[720px] mx-auto">
                <Skeleton className="h-8 w-64" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    if (!isNew && (isError || !story)) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                Story not found.{' '}
                <Button variant="link" onClick={() => navigate({ to: '/stories' })}>
                    Back to Stories
                </Button>
            </div>
        );
    }

    const assets = story?.metadata.assets ?? [];
    const mentionedPeople = Array.from(new Set([
        ...(story?.metadata.people ?? []),
        ...(story?.mentions ?? []),
    ]));

    // ── Shared header ─────────────────────────────────────────────────────────

    const header = (
        <div className="flex items-center gap-3 px-4 py-2 border-b border-border shrink-0 bg-card">
            <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => navigate({ to: '/stories' })}
                aria-label="Back to Stories"
            >
                <ArrowLeft className="h-4 w-4" />
            </Button>
            <nav className="text-sm text-muted-foreground flex items-center gap-1">
                <Link to="/stories" className="hover:text-foreground transition-colors">
                    Stories
                </Link>
                <span>/</span>
                <span className="text-foreground font-medium truncate max-w-[260px]">
                    {fm.title || (isNew ? 'New Story' : story?.metadata.title)}
                </span>
            </nav>

            <div className="ml-auto flex items-center gap-2">
                {!isNew && (
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => setShowDeleteConfirm(true)}
                        aria-label="Delete story"
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                )}
                {isEditMode && (
                    <span className="text-xs text-muted-foreground italic">
                        {isSaving ? 'Saving…' : isDirty ? 'Unsaved' : 'Saved'}
                    </span>
                )}
                {isEditMode ? (
                    <>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-muted-foreground"
                            onClick={() => setShowDiscardConfirm(true)}
                            disabled={isSaving}
                        >
                            Discard
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8"
                            onClick={() => doSave(true)}
                            disabled={isSaving || (isNew && !fm.title.trim())}
                        >
                            <Save className="h-3.5 w-3.5 mr-1.5" />
                            {isNew ? 'Create' : 'Save'}
                        </Button>
                    </>
                ) : (
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={() => navigate({ to: '/stories/$id', params: { id }, search: { mode: 'edit' } })}
                    >
                        <Pencil className="h-3.5 w-3.5 mr-1.5" />
                        Edit Story
                    </Button>
                )}
            </div>
        </div>
    );

    // ── Filmstrip ─────────────────────────────────────────────────────────────

    const filmstrip = assets.length > 0 ? (
        <div className="mt-8">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Photos & Attachments
            </h3>
            <div className="flex gap-2 overflow-x-auto pb-2">
                {assets.map((asset, i) => {
                    const isCover = i === 0;
                    return (
                        <div key={asset} className="relative shrink-0 group/thumb">
                            <button
                                onClick={() => setLightboxAsset(asset)}
                                className={`w-24 h-24 rounded-md overflow-hidden border transition-colors ${
                                    isCover ? 'border-primary/60' : 'border-border hover:border-primary/50'
                                }`}
                            >
                                <img
                                    src={`/assets/${asset}`}
                                    alt={asset}
                                    className="w-full h-full object-cover"
                                    loading="lazy"
                                />
                            </button>
                            {/* Cover badge */}
                            {isCover && (
                                <span className="absolute top-1 left-1 flex items-center gap-0.5 bg-primary/80 text-primary-foreground text-[9px] font-semibold px-1 py-0.5 rounded leading-none pointer-events-none">
                                    <Star className="h-2 w-2 fill-current" /> Cover
                                </span>
                            )}
                            {/* Edit mode overlays */}
                            {isEditMode && (
                                <div className="absolute inset-0 opacity-0 group-hover/thumb:opacity-100 transition-opacity rounded-md overflow-hidden">
                                    {/* Dim */}
                                    <div className="absolute inset-0 bg-black/40" />
                                    {/* Delete — top-right */}
                                    <button
                                        onClick={(e) => { e.stopPropagation(); setDeleteAssetTarget(asset); }}
                                        className="absolute top-1 right-1 p-0.5 rounded bg-black/50 hover:bg-destructive text-white"
                                        aria-label="Delete asset"
                                    >
                                        <Trash2 className="h-3 w-3" />
                                    </button>
                                    {/* Set cover — bottom, non-cover only */}
                                    {!isCover && (
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleSetCover(asset); }}
                                            className="absolute bottom-0 inset-x-0 flex items-center justify-center pb-1.5 text-white text-[9px] font-semibold gap-0.5"
                                        >
                                            <Star className="h-2.5 w-2.5" /> Set cover
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    ) : null;

    // ── Unified render (view + edit) ──────────────────────────────────────────

    const overlays = (
        <>
            {/* Asset delete confirmation */}
            <Dialog open={!!deleteAssetTarget} onOpenChange={(open) => !open && setDeleteAssetTarget(null)}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Delete photo?</DialogTitle>
                        <DialogDescription>
                            This photo will be permanently removed from the story. This cannot be undone.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button variant="outline" onClick={() => setDeleteAssetTarget(null)}>Cancel</Button>
                        <Button variant="destructive" onClick={handleDeleteAsset} disabled={deleteStoryMedia.isPending}>
                            {deleteStoryMedia.isPending ? 'Deleting…' : 'Delete'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Delete confirmation */}
            <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Delete story?</DialogTitle>
                        <DialogDescription>
                            "{fm.title || story?.metadata.title}" will be permanently deleted. This cannot be undone.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={handleDelete} disabled={deleteStory.isPending}>
                            {deleteStory.isPending ? 'Deleting…' : 'Delete'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Discard confirmation */}
            <Dialog open={showDiscardConfirm} onOpenChange={setShowDiscardConfirm}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Discard changes?</DialogTitle>
                        <DialogDescription>
                            {isNew
                                ? 'This story will not be saved and any uploaded images will be deleted.'
                                : 'Your unsaved changes will be reverted to the last saved version.'}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button variant="ghost" onClick={() => {
                            if (blocker.status === 'blocked') blocker.reset?.();
                            setShowDiscardConfirm(false);
                        }}>
                            Keep editing
                        </Button>
                        <Button variant="destructive" onClick={handleDiscard} disabled={isSaving}>
                            Discard
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Lightbox */}
            {lightboxAsset && (() => {
                const lbAssets = story?.metadata.assets ?? [];
                const lbIdx = lbAssets.indexOf(lightboxAsset);
                const isCover = lbIdx === 0;
                return (
                    <div
                        className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center"
                        onClick={() => setLightboxAsset(null)}
                    >
                        <button
                            type="button"
                            onClick={() => setLightboxAsset(null)}
                            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white"
                        >
                            <X className="h-5 w-5" />
                        </button>

                        {/* Prev */}
                        {lbAssets.length > 1 && (
                            <button
                                type="button"
                                className="absolute left-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setLightboxAsset(lbAssets[(lbIdx - 1 + lbAssets.length) % lbAssets.length]);
                                }}
                            >
                                <ChevronLeft className="h-6 w-6" />
                            </button>
                        )}

                        <div className="flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
                            <img
                                src={`/assets/${lightboxAsset}`}
                                alt={lightboxAsset}
                                className="max-w-[90vw] max-h-[80vh] object-contain rounded-lg shadow-2xl"
                            />
                            {/* Footer: counter + set cover */}
                            <div className="flex items-center gap-4">
                                {lbAssets.length > 1 && (
                                    <span className="text-white/60 text-sm tabular-nums">
                                        {lbIdx + 1} / {lbAssets.length}
                                    </span>
                                )}
                                {isEditMode && !isCover && (
                                    <button
                                        type="button"
                                        onClick={() => handleSetCover(lightboxAsset)}
                                        className="flex items-center gap-1.5 text-sm text-white/80 hover:text-white bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-full transition-colors"
                                    >
                                        <Star className="h-3.5 w-3.5" />
                                        Set as cover
                                    </button>
                                )}
                                {isCover && (
                                    <span className="flex items-center gap-1.5 text-sm text-primary-foreground/80 bg-primary/60 px-3 py-1.5 rounded-full">
                                        <Star className="h-3.5 w-3.5 fill-current" />
                                        Cover image
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Next */}
                        {lbAssets.length > 1 && (
                            <button
                                type="button"
                                className="absolute right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setLightboxAsset(lbAssets[(lbIdx + 1) % lbAssets.length]);
                                }}
                            >
                                <ChevronRight className="h-6 w-6" />
                            </button>
                        )}
                    </div>
                );
            })()}
        </>
    );

    return (
        <PageShell header={header} bodyClassName="overflow-y-auto" overlays={overlays}>
            <div className="max-w-[720px] mx-auto px-6 py-8">
                    {/* Title — same visual styles in both modes */}
                    {isEditMode ? (
                        <input
                            type="text"
                            placeholder="Story title…"
                            value={fm.title}
                            onChange={(e) => { setFm((p) => ({ ...p, title: e.target.value })); setIsDirty(true); }}
                            className="w-full mb-3 bg-transparent border-none outline-none text-3xl font-bold text-foreground placeholder:text-muted-foreground/50"
                            style={{ fontFamily: 'Merriweather, Georgia, serif', lineHeight: '1.3', fontSize: '1.875rem' }}
                        />
                    ) : (
                        <h1
                            className="font-serif text-3xl font-bold mb-3"
                            style={{ fontFamily: 'Merriweather, Georgia, serif', lineHeight: '1.3' }}
                        >
                            {fm.title || story?.metadata.title}
                        </h1>
                    )}

                    {/* Meta row */}
                    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 mb-4">
                        {isEditMode ? (
                            <>
                                {/* Date */}
                                <div className="flex items-center gap-1.5">
                                    <CalendarDays className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                    <SmartDateInput
                                        value={fm.date}
                                        onChange={(display) => { setFm((p) => ({ ...p, date: display })); setIsDirty(true); }}
                                        placeholder="Date (e.g. 15 Jun 1944)"
                                        className="h-7 text-sm w-52 border-muted"
                                    />
                                </div>

                                {/* Place */}
                                <PlaceSearchCombobox
                                    value={formatPlaceDisplay(fm.place)}
                                    onChange={(text) => { setFm((p) => ({ ...p, place: text ? { name: text } : undefined })); setIsDirty(true); }}
                                    onSelect={(place) => { setFm((p) => ({ ...p, place })); setIsDirty(true); }}
                                    initialPlace={fm.place}
                                />

                                {/* Private toggle */}
                                <button
                                    onClick={() => { setFm((p) => ({ ...p, isPrivate: !p.isPrivate })); setIsDirty(true); }}
                                    className={`flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors ${
                                        fm.isPrivate
                                            ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                            : 'text-muted-foreground hover:bg-muted'
                                    }`}
                                >
                                    {fm.isPrivate ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                                    {fm.isPrivate ? 'Private' : 'Public'}
                                </button>
                            </>
                        ) : (
                            <>
                                {!!fm.date && (
                                    <span
                                        className="h-7 flex items-center gap-1 text-sm text-muted-foreground"
                                        title="When this story occurred"
                                    >
                                        <CalendarDays className="h-3.5 w-3.5 shrink-0" />
                                        {fm.date}
                                    </span>
                                )}
                                {!!fm.place && (
                                    <span className="flex items-center gap-1 text-sm text-muted-foreground">
                                        <MapPin className="h-3.5 w-3.5 shrink-0" />
                                        <span>
                                            {formatPlaceDisplay(fm.place)}
                                            {!!formatCoordinates(fm.place) && (
                                                <span className="ml-1.5 text-xs text-green-600 dark:text-green-400">{formatCoordinates(fm.place)}</span>
                                            )}
                                        </span>
                                    </span>
                                )}
                                {!!fm.isPrivate && (
                                    <span className="h-7 flex items-center">
                                        <Badge variant="secondary" className="text-xs">
                                            <Lock className="h-3 w-3 mr-1" />
                                            Private
                                        </Badge>
                                    </span>
                                )}
                            </>
                        )}
                    </div>

                    {/* People chips — always shown */}
                    {mentionedPeople.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 mb-3">
                            {mentionedPeople.map((pid) => (
                                <PersonChip key={pid} id={pid} />
                            ))}
                        </div>
                    )}

                    {/* Body — bordered section marks where prose begins and ends */}
                    <div className="border-t border-b border-border py-6">
                        {(isEditMode || content) && (
                            <MilkdownEditor
                                ref={editorRef}
                                key={`editor-${id}-${story ? 'loaded' : 'unloaded'}-${editorResetKey}`}
                                content={content}
                                onChange={(md) => { setContent(md); setIsDirty(true); }}
                                onImageUpload={handleImageUpload}
                                enableMentions={true}
                                readOnly={!isEditMode}
                                onMentionClick={!isEditMode ? handleMentionClick : undefined}
                            />
                        )}

                        {/* Tip — below editor, inside content boundary */}
                        {isEditMode && (
                            <p className="text-[10px] text-muted-foreground/50 mt-3">
                                Tip: type <kbd className="font-mono bg-muted px-0.5 rounded">@</kbd> to mention a person, <kbd className="font-mono bg-muted px-0.5 rounded">/</kbd> for block commands, or write raw Markdown.
                            </p>
                        )}
                    </div>

                    {filmstrip}

                    {!isEditMode && story?.metadata.modified_at && (
                        <p className="text-[10px] text-muted-foreground/50 mt-4 text-right">
                            Last edited {new Date(story.metadata.modified_at).toLocaleDateString()}
                        </p>
                    )}
            </div>
        </PageShell>
    );
}
