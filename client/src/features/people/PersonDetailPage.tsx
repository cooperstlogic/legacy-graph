import { useNavigate } from '@tanstack/react-router';
import { usePerson, useUpdatePerson, useDeleteAsset, useDeleteAssetPermanently, useAssets, useLinkAsset } from '@/shared/api/hooks';
import type { AssetListItem } from '@/shared/api/client';
import type { TimelineEventItem } from '@/shared/api/people';
import { AssetLightbox } from '@/features/assets/components/AssetLightbox';
import { AssetPickerDialog } from '@/features/assets/components/AssetPickerDialog';
import { CustomAvatar } from '@/shared/components/CustomAvatar';
import { loadAvatarCrop, saveAvatarCrop, clearAvatarCrop } from '@/shared/lib/avatarCrop';
import { assetType, primaryImageAsset } from '@/shared/lib/assets';
import { EventEditorDialog } from '@/features/people/components/EventEditorDialog';
import { RelationshipEditorDialog } from '@/features/people/components/RelationshipEditorDialog';
import { AvatarCropDialog } from '@/features/people/components/AvatarCropDialog';
import {
    Dialog as ConfirmDialog,
    DialogContent as ConfirmDialogContent,
    DialogHeader as ConfirmDialogHeader,
    DialogTitle as ConfirmDialogTitle,
    DialogDescription as ConfirmDialogDescription,
    DialogFooter as ConfirmDialogFooter,
} from '@/shared/ui/dialog';
import { Badge } from '@/shared/ui/badge';
import { Skeleton } from '@/shared/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from '@/shared/ui/resizable';
import {
    Sunrise, Sunset, FileText, Plus, Image, BookOpen, Code,
    Pencil, X, Check, UserPlus, Star, ZoomIn, Upload, Trash2, Crop, Link2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MilkdownEditor, type MilkdownEditorHandle } from '@/shared/components/MilkdownEditor';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PersonTimeline } from './components/PersonTimeline';
import { RelationshipSection } from './components/RelationshipSection';

const SEX_OPTIONS = ['M', 'F', 'I', 'U'] as const;
const SEX_LABELS: Record<string, string> = { M: 'Male', F: 'Female', I: 'Intersex', U: 'Unknown' };

type CropArea = { x: number; y: number; width: number; height: number };

export function PersonDetailPage({ id }: { id: string }) {
    const navigate = useNavigate();
    const { data: person, isLoading, isError } = usePerson(id);
    const updatePerson = useUpdatePerson();
    const queryClient = useQueryClient();
    const { data: allAssetsData } = useAssets();
    const assetMetaMap = useMemo(() => {
        const map = new Map<string, AssetListItem>();
        for (const a of allAssetsData?.assets ?? []) map.set(a.filename, a);
        return map;
    }, [allAssetsData]);

    // Inline editing state
    const [editingName, setEditingName] = useState(false);
    const [editFirstName, setEditFirstName] = useState('');
    const [editLastName, setEditLastName] = useState('');
    const [editingSex, setEditingSex] = useState(false);
    const [addingTag, setAddingTag] = useState(false);
    const [newTag, setNewTag] = useState('');

    // Dialog state
    const [eventDialogOpen, setEventDialogOpen] = useState(false);
    const [editingEventIndex, setEditingEventIndex] = useState<number | undefined>(undefined);
    const [eventInitialType, setEventInitialType] = useState<string | undefined>(undefined);
    const [relationshipDialogOpen, setRelationshipDialogOpen] = useState(false);

    // Notebook editing state
    const [editingNotebook, setEditingNotebook] = useState(false);
    const [notebookContent, setNotebookContent] = useState('');
    const notebookEditorRef = useRef<MilkdownEditorHandle>(null);

    // Drag state for asset upload
    const [isDragOver, setIsDragOver] = useState(false);

    // Asset panel state
    const [lightboxAsset, setLightboxAsset] = useState<string | null>(null);
    const [deleteConfirmAsset, setDeleteConfirmAsset] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const deleteAssetMutation = useDeleteAsset();
    const deleteAssetPermanentlyMutation = useDeleteAssetPermanently();
    const linkAsset = useLinkAsset();
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [showCropDialog, setShowCropDialog] = useState(false);
    const [avatarCrop, setAvatarCrop] = useState<CropArea | null>(null);

    // Reset all editing state when navigating to a different person
    useEffect(() => {
        setEditingName(false);
        setEditingSex(false);
        setAddingTag(false);
        setNewTag('');
        setEventDialogOpen(false);
        setEditingEventIndex(undefined);
        setEventInitialType(undefined);
        setRelationshipDialogOpen(false);
        setEditingNotebook(false);
        setLightboxAsset(null);
        setShowCropDialog(false);
        setAvatarCrop(loadAvatarCrop(id));
    }, [id]);


    if (isLoading) {
        return (
            <div className="p-6 space-y-4">
                <div className="flex items-center gap-4">
                    <Skeleton className="h-20 w-20 rounded-full" />
                    <div className="space-y-2">
                        <Skeleton className="h-6 w-48" />
                        <Skeleton className="h-4 w-32" />
                    </div>
                </div>
            </div>
        );
    }

    if (isError || !person) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                Failed to load person data.
            </div>
        );
    }

    const primaryName = person.names?.[0];
    const firstName = primaryName?.first || primaryName?.given || '';
    const lastName = primaryName?.last || primaryName?.surname || '';
    const displayName = `${firstName} ${lastName}`.trim() || 'Unknown';
    const timeline = person.timeline ?? [];
    const computed = person._computed ?? { currentSpouse: null, siblings: [], children: [], allSpouses: [] };
    const tags = person.tags ?? [];

    // Derive birth/death dates from events
    const events = (person.events ?? []) as Array<Record<string, unknown>>;
    const birthDate = events.find((e) => e.type === 'birth')?.date as string | undefined;
    const deathDate = events.find((e) => e.type === 'death')?.date as string | undefined;

    const allAssets = (person.assets ?? []) as string[];
    const primaryPhoto = primaryImageAsset(allAssets);

    const parentIds = person.relationships?.parents ?? [];
    const spouseIds = computed.allSpouses?.map((s) => s.id) ?? [];
    const childIds = computed.children ?? [];
    const siblingIds = computed.siblings ?? [];

    const hasRelationships = parentIds.length > 0 || spouseIds.length > 0 || childIds.length > 0 || siblingIds.length > 0;

    // --- Name editing ---
    const startEditName = () => {
        setEditFirstName(firstName);
        setEditLastName(lastName);
        setEditingName(true);
    };

    const saveNameEdit = () => {
        const updatedNames = person.names ? [...person.names] : [];
        if (updatedNames.length > 0) {
            updatedNames[0] = {
                ...updatedNames[0],
                given: editFirstName.trim(),
                first: editFirstName.trim(),
                surname: editLastName.trim(),
                last: editLastName.trim(),
            };
        } else {
            updatedNames.push({ given: editFirstName.trim(), surname: editLastName.trim(), primary: true });
        }
        updatePerson.mutate(
            { id, updates: { names: updatedNames } },
            {
                onSuccess: () => toast.success('Name updated.'),
                onError: () => toast.error('Failed to update name.'),
            }
        );
        setEditingName(false);
    };

    const cancelNameEdit = () => setEditingName(false);

    // --- Sex editing ---
    const saveSex = (newSex: string) => {
        setEditingSex(false);
        updatePerson.mutate(
            { id, updates: { sex: newSex } },
            {
                onSuccess: () => toast.success('Sex updated.'),
                onError: () => toast.error('Failed to update sex.'),
            }
        );
    };

    // --- Tag editing ---
    const addTag = () => {
        const tag = newTag.trim();
        if (!tag) return;
        if (tags.includes(tag)) { toast.error('Tag already exists.'); return; }
        const updated = [...tags, tag];
        updatePerson.mutate(
            { id, updates: { tags: updated } },
            {
                onSuccess: () => toast.success('Tag added.'),
                onError: () => toast.error('Failed to add tag.'),
            }
        );
        setNewTag('');
        setAddingTag(false);
    };

    const removeTag = (tag: string) => {
        const updated = tags.filter((t: string) => t !== tag);
        updatePerson.mutate(
            { id, updates: { tags: updated } },
            {
                onSuccess: () => toast.success('Tag removed.'),
                onError: () => toast.error('Failed to remove tag.'),
            }
        );
    };

    // --- Notebook editing ---
    const startEditNotebook = () => {
        setNotebookContent(person.scrapbook_md ?? '');
        setEditingNotebook(true);
    };

    const saveNotebook = () => {
        // notebookContent trails the editor by Milkdown's onChange debounce
        const latest = notebookEditorRef.current?.getMarkdown() ?? notebookContent;
        updatePerson.mutate(
            { id, updates: { scrapbook_md: latest } },
            {
                onSuccess: () => toast.success('Notebook saved.'),
                onError: () => toast.error('Failed to save notebook.'),
            }
        );
        setEditingNotebook(false);
    };

    // --- Asset upload (shared by drag-drop and file dialog) ---
    const uploadFiles = async (files: File[]) => {
        if (files.length === 0) return;
        // Sequential uploads to avoid read-modify-write races on person.assets[]
        const results: Array<{ ok: boolean; name: string; error?: string }> = [];
        for (const file of files) {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch(`/api/people/${id}/media`, { method: 'PUT', body: formData });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                results.push({ ok: false, name: file.name, error: body?.error ?? 'Upload failed' });
            } else {
                results.push({ ok: true, name: file.name });
            }
        }
        const failed = results.filter(r => !r.ok);
        const succeeded = results.filter(r => r.ok);
        if (succeeded.length > 0) {
            toast.success(succeeded.length === 1 ? 'Asset uploaded.' : `${succeeded.length} assets uploaded.`);
            queryClient.invalidateQueries({ queryKey: ['person', id] });
            queryClient.invalidateQueries({ queryKey: ['assets'] });
        }
        for (const f of failed) toast.error(`Failed to upload "${f.name}": ${f.error}`);
    };

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length > 0) uploadFiles(files);
    };

    const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        if (files.length > 0) uploadFiles(files);
        e.target.value = '';
    };

    // Set an asset as primary (first in the assets array)
    const handleSetPrimary = (filename: string) => {
        const currentAssets = (person.assets ?? []) as string[];
        if (currentAssets[0] === filename) return;
        const updated = [filename, ...currentAssets.filter((a) => a !== filename)];
        updatePerson.mutate(
            { id, updates: { assets: updated } },
            {
                onSuccess: () => {
                    clearAvatarCrop(id);
                    setAvatarCrop(null);
                    toast.success('Primary photo updated.');
                },
                onError: () => toast.error('Failed to update primary photo.'),
            }
        );
    };

    // Delete an asset — open confirmation dialog
    const handleDeleteAsset = (filename: string) => {
        setDeleteConfirmAsset(filename);
    };

    const handleConfirmDeleteAsset = () => {
        if (!deleteConfirmAsset) return;
        const filename = deleteConfirmAsset;
        const currentAssets = (person.assets as string[]);
        const idx = currentAssets.indexOf(filename);
        const nextAsset = currentAssets[idx + 1] ?? currentAssets[idx - 1] ?? null;
        setDeleteConfirmAsset(null);
        deleteAssetMutation.mutate(
            { personId: id, filename },
            {
                onSuccess: () => {
                    toast.success('Removed from profile.');
                    if (lightboxAsset === filename) setLightboxAsset(nextAsset);
                },
                onError: () => toast.error('Failed to remove asset.'),
            }
        );
    };

    const handleDeleteFileEntirely = () => {
        if (!deleteConfirmAsset) return;
        const filename = deleteConfirmAsset;
        const currentAssets = (person.assets as string[]);
        const idx = currentAssets.indexOf(filename);
        const nextAsset = currentAssets[idx + 1] ?? currentAssets[idx - 1] ?? null;
        setDeleteConfirmAsset(null);
        deleteAssetPermanentlyMutation.mutate(
            { personId: id, filename },
            {
                onSuccess: (result) => {
                    if (result.fileDeleted) {
                        toast.success(`${filename} deleted.`);
                    } else {
                        toast.success('Removed from profile. File kept — still referenced elsewhere.');
                    }
                    if (lightboxAsset === filename) setLightboxAsset(nextAsset);
                },
                onError: () => toast.error('Failed to delete asset.'),
            }
        );
    };

    // Open the event editor for a specific event type (or to edit an existing event)
    const openEventDialog = (type?: string, eventIndex?: number) => {
        setEditingEventIndex(eventIndex);
        setEventInitialType(type);
        setEventDialogOpen(true);
    };

    // --- Event editor ---
    const openAddEvent = () => { openEventDialog(); };

    const openEditEvent = (timelineItem: TimelineEventItem) => {
        const rawEvent = timelineItem.data;
        const idx = events.findIndex((e) => JSON.stringify(e) === JSON.stringify(rawEvent));
        if (idx < 0) return;
        openEventDialog(rawEvent.type as string, idx);
    };

    const existingEvent = editingEventIndex !== undefined ? events[editingEventIndex] : undefined;

    return (
        <>
            <ResizablePanelGroup orientation="horizontal" className="h-full">
                {/* Identity Panel */}
                <ResizablePanel defaultSize="22%" minSize="15%" maxSize="35%">
                    <div className="h-full overflow-y-auto p-4 space-y-6">
                        {/* Avatar + Name */}
                        <div className="flex flex-col items-center text-center gap-3 pt-2">
                            <div
                                className={`relative group ${!primaryPhoto ? 'cursor-pointer' : ''}`}
                                onClick={!primaryPhoto ? () => fileInputRef.current?.click() : undefined}
                                title={!primaryPhoto ? 'Upload a photo' : undefined}
                            >
                                <CustomAvatar
                                    firstName={primaryName?.given ?? firstName}
                                    lastName={primaryName?.surname ?? lastName}
                                    photoFilename={primaryPhoto}
                                    className="h-20 w-20 text-2xl"
                                    cropData={avatarCrop}
                                    sex={person.sex}
                                    onClick={primaryPhoto ? () => setLightboxAsset(primaryPhoto) : undefined}
                                />
                                {!primaryPhoto && (
                                    <div className="absolute inset-0 rounded-full flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <Upload className="h-5 w-5 text-white" />
                                    </div>
                                )}
                            </div>
                            <div className="w-full">
                                {editingName ? (
                                    <div className="space-y-2">
                                        <Input
                                            value={editFirstName}
                                            onChange={(e) => setEditFirstName(e.target.value)}
                                            placeholder="First name"
                                            className="h-7 text-sm text-center"
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') saveNameEdit();
                                                if (e.key === 'Escape') cancelNameEdit();
                                            }}
                                            autoFocus
                                        />
                                        <Input
                                            value={editLastName}
                                            onChange={(e) => setEditLastName(e.target.value)}
                                            placeholder="Last name"
                                            className="h-7 text-sm text-center"
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') saveNameEdit();
                                                if (e.key === 'Escape') cancelNameEdit();
                                            }}
                                        />
                                        <div className="flex gap-1 justify-center">
                                            <Button size="sm" className="h-6 px-2 text-xs" onClick={saveNameEdit}>
                                                <Check className="h-3 w-3" />
                                            </Button>
                                            <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={cancelNameEdit}>
                                                <X className="h-3 w-3" />
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <button
                                        onClick={startEditName}
                                        className="group flex items-center justify-center gap-1 w-full"
                                        title="Click to edit name"
                                    >
                                        <h2 className="text-xl font-bold tracking-tight">{displayName}</h2>
                                        <Pencil className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                                    </button>
                                )}
                                {person.names?.length > 1 && !editingName && (
                                    <p className="text-sm text-muted-foreground mt-0.5">
                                        {person.names.slice(1).map((n: typeof primaryName) => `${n?.first || n?.given || ''} ${n?.last || n?.surname || ''}`.trim()).join(', ')}
                                    </p>
                                )}
                            </div>
                        </div>

                        {/* Vital dates + sex */}
                        <div className="space-y-2 border-t border-border pt-4">
                            <div className="flex items-center gap-2 text-sm">
                                {editingSex ? (
                                    <div className="flex gap-1.5 flex-wrap">
                                        {SEX_OPTIONS.map((s) => (
                                            <button
                                                key={s}
                                                onClick={() => saveSex(s)}
                                                className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
                                                    person.sex === s
                                                        ? 'bg-primary text-primary-foreground border-primary'
                                                        : 'border-border hover:bg-muted'
                                                }`}
                                            >
                                                {SEX_LABELS[s]}
                                            </button>
                                        ))}
                                        <button
                                            onClick={() => setEditingSex(false)}
                                            className="p-0.5 rounded hover:bg-muted"
                                        >
                                            <X className="h-3 w-3 text-muted-foreground" />
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        onClick={() => setEditingSex(true)}
                                        className="group flex items-center gap-1"
                                        title="Click to edit sex"
                                    >
                                        <Badge variant="outline" className="text-xs px-1.5">{SEX_LABELS[person.sex ?? 'U']}</Badge>
                                        <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                                    </button>
                                )}
                            </div>
                            {birthDate ? (
                                <button
                                    className="group flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                                    onClick={() => { openEventDialog('birth', events.findIndex((e) => e.type === 'birth')); }}
                                    title="Edit birth event"
                                >
                                    <Sunrise className="h-4 w-4 shrink-0" />
                                    <span>b. {birthDate}</span>
                                    <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                                </button>
                            ) : (
                                <button
                                    className="flex items-center gap-2 text-sm text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                                    onClick={() => openEventDialog('birth')}
                                    title="Add birth event"
                                >
                                    <Sunrise className="h-4 w-4 shrink-0" />
                                    <span>Add birth date</span>
                                    <Plus className="h-3 w-3" />
                                </button>
                            )}
                            {deathDate ? (
                                <button
                                    className="group flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                                    onClick={() => { openEventDialog('death', events.findIndex((e) => e.type === 'death')); }}
                                    title="Edit death event"
                                >
                                    <Sunset className="h-4 w-4 shrink-0" />
                                    <span>d. {deathDate}</span>
                                    <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                                </button>
                            ) : (
                                <button
                                    className="flex items-center gap-2 text-sm text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                                    onClick={() => openEventDialog('death')}
                                    title="Add death event"
                                >
                                    <Sunset className="h-4 w-4 shrink-0" />
                                    <span>Add death date</span>
                                    <Plus className="h-3 w-3" />
                                </button>
                            )}
                        </div>

                        {/* Relationships */}
                        <div className="space-y-3 border-t border-border pt-4">
                            {hasRelationships && (
                                <>
                                    <RelationshipSection title="Parents" ids={parentIds.map((p) => p.id)} />
                                    <RelationshipSection title="Spouses" ids={spouseIds} />
                                    <RelationshipSection title="Children" ids={childIds} />
                                    <RelationshipSection title="Siblings" ids={siblingIds} />
                                </>
                            )}
                            <Button
                                variant="outline"
                                size="sm"
                                className="w-full gap-1.5 text-xs"
                                onClick={() => setRelationshipDialogOpen(true)}
                            >
                                <UserPlus className="h-3.5 w-3.5" />
                                Manage Relationships
                            </Button>
                        </div>

                        {/* Tags */}
                        <div className="space-y-2 border-t border-border pt-4">
                            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tags</h3>
                            <div className="flex flex-wrap gap-1.5">
                                {tags.map((tag: string) => (
                                    <div key={tag} className="group flex items-center gap-0.5">
                                        <Badge variant="secondary" className="text-xs pr-1">{tag}</Badge>
                                        <button
                                            onClick={() => removeTag(tag)}
                                            className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-destructive"
                                            aria-label={`Remove tag ${tag}`}
                                        >
                                            <X className="h-3 w-3" />
                                        </button>
                                    </div>
                                ))}
                                {addingTag ? (
                                    <div className="flex items-center gap-1">
                                        <Input
                                            value={newTag}
                                            onChange={(e) => setNewTag(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') addTag();
                                                if (e.key === 'Escape') { setAddingTag(false); setNewTag(''); }
                                            }}
                                            placeholder="tag"
                                            className="h-6 w-20 text-xs"
                                            autoFocus
                                        />
                                        <button onClick={addTag} className="hover:text-primary">
                                            <Check className="h-3 w-3" />
                                        </button>
                                        <button onClick={() => { setAddingTag(false); setNewTag(''); }}>
                                            <X className="h-3 w-3 text-muted-foreground" />
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        onClick={() => setAddingTag(true)}
                                        className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-dashed border-border hover:border-primary transition-colors"
                                    >
                                        <Plus className="h-3 w-3" /> Add
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </ResizablePanel>

                <ResizableHandle withHandle />

                {/* Timeline Panel */}
                <ResizablePanel defaultSize="50%" minSize="30%">
                    <div className="h-full flex flex-col">
                        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                            <h3 className="text-sm font-semibold">Timeline</h3>
                            <div className="flex flex-col items-end gap-1">
                                <Button variant="outline" size="sm" className="gap-1" onClick={openAddEvent}>
                                    <Plus className="h-3 w-3" /> Add Event
                                </Button>
                                <button
                                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                                    onClick={() => navigate({ to: '/stories/$id', params: { id: 'new' }, search: { person: id } })}
                                >
                                    <BookOpen className="h-3 w-3" /> Write a story
                                </button>
                            </div>
                        </div>
                        <PersonTimeline
                            key={id}
                            timeline={timeline}
                            onEditEvent={openEditEvent}
                        />
                    </div>
                </ResizablePanel>

                <ResizableHandle withHandle />

                {/* Context Panel */}
                <ResizablePanel defaultSize="28%" minSize="15%" maxSize="40%">
                    <Tabs defaultValue="assets" className="h-full flex flex-col">
                        <TabsList className="w-full justify-start rounded-none border-b border-border bg-transparent px-2 pt-1">
                            <TabsTrigger value="assets" className="gap-1.5 text-xs">
                                <Image className="h-3.5 w-3.5" /> Assets
                            </TabsTrigger>
                            <TabsTrigger value="notebook" className="gap-1.5 text-xs">
                                <BookOpen className="h-3.5 w-3.5" /> Notebook
                            </TabsTrigger>
                            <TabsTrigger value="gedcom" className="gap-1.5 text-xs">
                                <Code className="h-3.5 w-3.5" /> GEDCOM
                            </TabsTrigger>
                        </TabsList>

                        {/* Assets tab with drag-drop + file dialog + gallery */}
                        <TabsContent value="assets" className="flex-1 overflow-auto p-4 mt-0">
                            {/* Hidden file input */}
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*,.pdf,.txt,.md"
                                multiple
                                className="hidden"
                                onChange={handleFileInputChange}
                            />
                            {/* Upload zone */}
                            <div
                                className={`rounded-lg border-2 border-dashed transition-colors mb-2 flex flex-col items-center justify-center gap-2 py-4 text-xs text-muted-foreground ${
                                    isDragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40'
                                }`}
                                onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                                onDragLeave={() => setIsDragOver(false)}
                                onDrop={handleDrop}
                            >
                                <Upload className="h-5 w-5 opacity-50" />
                                <span>{isDragOver ? 'Drop to upload' : 'Drop files here'}</span>
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    className="px-2.5 py-1 rounded border border-border text-xs hover:bg-muted transition-colors"
                                >
                                    Browse files
                                </button>
                            </div>
                            {/* Link existing assets */}
                            <button
                                type="button"
                                onClick={() => setAssetPickerOpen(true)}
                                className="w-full mb-3 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                            >
                                <Link2 className="h-3.5 w-3.5" /> Search existing assets
                            </button>
                            {allAssets.length > 0 ? (
                                <div className="grid grid-cols-2 gap-2">
                                    {allAssets.map((asset) => {
                                        const type = assetType(asset);
                                        const isImage = type === 'image';
                                        const isPrimary = asset === primaryPhoto;
                                        const isDoc = type === 'pdf' || type === 'text' || type === 'markdown';
                                        const assetMeta = assetMetaMap.get(asset)?.metadata;
                                        const caption = assetMeta?.description;
                                        const assetDisplayName = assetMeta?.name
                                            ? assetMeta.name
                                            : (() => { const dot = asset.lastIndexOf('.'); return (dot > 0 ? asset.slice(0, dot) : asset).replace(/[_-]/g, ' '); })();
                                        return (
                                        <div key={asset} className="group relative aspect-square rounded-lg bg-muted border border-border overflow-hidden">
                                            {isImage ? (
                                                <img
                                                    src={`/assets/${asset}`}
                                                    alt={assetDisplayName}
                                                    className="object-contain w-full h-full"
                                                    loading="lazy"
                                                />
                                            ) : (
                                                <div className="flex flex-col items-center justify-center w-full h-full gap-2 px-2">
                                                    <FileText className="h-8 w-8 text-muted-foreground" />
                                                    <span className="text-[10px] text-muted-foreground text-center break-all leading-tight">{assetDisplayName}</span>
                                                    <span className="text-[9px] uppercase tracking-wide text-muted-foreground/60 font-medium">
                                                        {type === 'pdf' ? 'PDF' : type === 'markdown' ? 'Markdown' : 'Text'}
                                                    </span>
                                                </div>
                                            )}
                                            {/* Primary badge — only for images */}
                                            {isPrimary && (
                                                <div className="absolute top-1 left-1 bg-primary/80 text-primary-foreground rounded px-1 py-0.5 text-[10px] font-medium flex items-center gap-0.5">
                                                    <Star className="h-2.5 w-2.5" /> Primary
                                                </div>
                                            )}
                                            {/* Caption overlay */}
                                            {!!caption && (
                                                <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1.5 py-0.5 pointer-events-none">
                                                    <p className="text-[9px] text-white truncate">{caption}</p>
                                                </div>
                                            )}
                                            {/* Hover controls */}
                                            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                                                <button
                                                    type="button"
                                                    title={isDoc ? 'View document' : 'View full size'}
                                                    onClick={() => setLightboxAsset(asset)}
                                                    className="p-1.5 rounded-full bg-white/20 hover:bg-white/30 text-white"
                                                >
                                                    <ZoomIn className="h-4 w-4" />
                                                </button>
                                                {/* Set as primary — images only, not already primary */}
                                                {isImage && !isPrimary && (
                                                    <button
                                                        type="button"
                                                        title="Set as primary photo"
                                                        onClick={() => handleSetPrimary(asset)}
                                                        className="p-1.5 rounded-full bg-white/20 hover:bg-white/30 text-white"
                                                    >
                                                        <Star className="h-4 w-4" />
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    title="Remove from profile"
                                                    onClick={(e) => { e.stopPropagation(); handleDeleteAsset(asset); }}
                                                    className="p-1.5 rounded-full bg-white/20 hover:bg-red-500/70 text-white"
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                </button>
                                            </div>
                                        </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className="text-center text-muted-foreground text-sm py-4">No assets yet</div>
                            )}

                        </TabsContent>

                        {/* Notebook tab with edit toggle */}
                        <TabsContent value="notebook" className="flex-1 overflow-auto p-4 mt-0 flex flex-col gap-3">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Notes</span>
                                {editingNotebook ? (
                                    <div className="flex gap-1">
                                        <Button size="sm" className="h-6 px-2 text-xs" onClick={saveNotebook}>Save</Button>
                                        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => setEditingNotebook(false)}>Cancel</Button>
                                    </div>
                                ) : (
                                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs gap-1" onClick={startEditNotebook}>
                                        <Pencil className="h-3 w-3" /> Edit
                                    </Button>
                                )}
                            </div>
                            <MilkdownEditor
                                ref={notebookEditorRef}
                                content={editingNotebook ? notebookContent : (person.scrapbook_md ?? '')}
                                onChange={setNotebookContent}
                                readOnly={!editingNotebook}
                                enableMentions={false}
                                className="rounded-md border border-input bg-transparent text-sm"
                            />
                            {!editingNotebook && !person.scrapbook_md && (
                                <p className="text-sm text-muted-foreground italic">No notebook entries. Click Edit to add notes.</p>
                            )}
                        </TabsContent>

                        <TabsContent value="gedcom" className="flex-1 overflow-auto p-4 mt-0">
                            {person._gedcom ? (
                                <pre className="text-xs font-mono bg-muted/50 p-4 rounded-lg overflow-auto whitespace-pre-wrap">
                                    {JSON.stringify(person._gedcom, null, 2)}
                                </pre>
                            ) : (
                                <div className="p-8 text-center text-muted-foreground text-sm">No GEDCOM data available</div>
                            )}
                        </TabsContent>
                    </Tabs>
                </ResizablePanel>
            </ResizablePanelGroup>

            {/* Link existing assets picker */}
            <AssetPickerDialog
                open={assetPickerOpen}
                onOpenChange={setAssetPickerOpen}
                onConfirm={(filenames) => {
                    Promise.all(
                        filenames.map(fn => linkAsset.mutateAsync({ personId: id, filename: fn }))
                    ).then(() => {
                        toast.success(filenames.length === 1 ? '1 asset linked.' : `${filenames.length} assets linked.`);
                    }).catch(() => {
                        toast.error('Some assets could not be linked.');
                    });
                }}
                excludeFilenames={person?.assets as string[] ?? []}
                title="Link Existing Assets"
            />

            {/* Asset Lightbox */}
            {lightboxAsset && (() => {
                const lbAssets = (person.assets as string[]);
                const lbAssetData = assetMetaMap.get(lightboxAsset);
                return (
                    <AssetLightbox
                        filename={lightboxAsset}
                        allFilenames={lbAssets}
                        assetData={lbAssetData}
                        onClose={() => setLightboxAsset(null)}
                        onNavigate={(fn) => setLightboxAsset(fn)}
                        onDeleteRequest={(fn) => handleDeleteAsset(fn)}
                        overlayContent={lightboxAsset === primaryPhoto ? (
                            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/60 backdrop-blur-sm rounded-full px-4 py-2">
                                <div className="flex items-center gap-1.5 text-white text-xs">
                                    <Star className="h-3.5 w-3.5 text-yellow-400 fill-yellow-400" />
                                    <span>Primary photo</span>
                                </div>
                                <div className="w-px h-4 bg-white/30" />
                                <button type="button"
                                    onClick={() => { setLightboxAsset(null); setShowCropDialog(true); }}
                                    className="flex items-center gap-1.5 text-white/80 text-xs hover:text-white transition-colors">
                                    <Crop className="h-3.5 w-3.5" />
                                    <span>Crop avatar</span>
                                </button>
                            </div>
                        ) : undefined}
                    />
                );
            })()}

            {/* Dialogs */}
            <EventEditorDialog
                isOpen={eventDialogOpen}
                onClose={() => { setEventDialogOpen(false); setEditingEventIndex(undefined); setEventInitialType(undefined); }}
                personId={id}
                personChip={{ id, name: displayName }}
                existingEvent={existingEvent}
                existingEventIndex={editingEventIndex}
                currentEvents={events}
                initialEventType={eventInitialType as Parameters<typeof EventEditorDialog>[0]['initialEventType']}
            />
            <RelationshipEditorDialog
                isOpen={relationshipDialogOpen}
                onClose={() => setRelationshipDialogOpen(false)}
                personId={id}
                currentParents={person.relationships?.parents ?? []}
                currentChildIds={childIds}
                allSpouses={computed.allSpouses ?? []}
                currentEvents={events}
                siblings={computed.siblings ?? []}
            />

            {/* Avatar crop dialog — triggered from lightbox on primary image */}
            {showCropDialog && !!primaryPhoto && (
                <AvatarCropDialog
                    imageSrc={`/assets/${primaryPhoto}`}
                    onConfirm={(area) => {
                        saveAvatarCrop(id, area);
                        setAvatarCrop(area);
                        setShowCropDialog(false);
                    }}
                    onCancel={() => setShowCropDialog(false)}
                />
            )}

            {/* Asset remove confirmation */}
            <ConfirmDialog open={!!deleteConfirmAsset} onOpenChange={(o) => !o && setDeleteConfirmAsset(null)}>
                <ConfirmDialogContent className="max-w-sm">
                    <ConfirmDialogHeader>
                        <ConfirmDialogTitle>Remove Asset</ConfirmDialogTitle>
                        <ConfirmDialogDescription>
                            What would you like to do with <span className="font-mono text-xs">{deleteConfirmAsset}</span>?
                        </ConfirmDialogDescription>
                    </ConfirmDialogHeader>
                    <div className="px-6 pb-2 space-y-2 text-sm text-muted-foreground">
                        <p><strong className="text-foreground">Remove from profile</strong> — unlinks the file from this person. It stays in the asset gallery.</p>
                        <p><strong className="text-foreground">Delete asset</strong> — permanently removes the file from disk.</p>
                    </div>
                    <ConfirmDialogFooter className="flex-col sm:flex-row gap-2">
                        <Button variant="outline" size="sm" onClick={() => setDeleteConfirmAsset(null)}>Cancel</Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handleConfirmDeleteAsset}
                            disabled={deleteAssetMutation.isPending || deleteAssetPermanentlyMutation.isPending}
                        >
                            {deleteAssetMutation.isPending ? 'Removing…' : 'Remove from profile'}
                        </Button>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={handleDeleteFileEntirely}
                            disabled={deleteAssetMutation.isPending || deleteAssetPermanentlyMutation.isPending}
                        >
                            {deleteAssetPermanentlyMutation.isPending ? 'Deleting…' : 'Delete asset'}
                        </Button>
                    </ConfirmDialogFooter>
                </ConfirmDialogContent>
            </ConfirmDialog>
        </>
    );
}
