import { useState, useRef, useEffect } from 'react';
import { uploadGalleryAssets, updateAssetMeta, linkAssetToPerson } from '@/shared/api/client';
import type { AssetMetadata } from '@/shared/api/client';
import type { Place } from '@/shared/api/people';
import { PlaceSearchCombobox } from '@/shared/components/PlaceSearchCombobox';
import { PersonSearchCombobox } from '@/shared/components/PersonSearchCombobox';
import { PersonChip } from '@/shared/components/PersonChip';
import { SmartDateInput, parseToISO } from '@/shared/components/SmartDateInput';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/shared/ui/dialog';
import { FileText, Upload, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface BulkUploadDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: () => void;
}

export function BulkUploadDialog({ open, onOpenChange, onSuccess }: BulkUploadDialogProps) {
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const [description, setDescription] = useState('');
    const [dateVal, setDateVal] = useState('');
    const [locationQuery, setLocationQuery] = useState('');
    const [locationPlace, setLocationPlace] = useState<Place | null>(null);
    const [taggedPeople, setTaggedPeople] = useState<string[]>([]);
    const [uploading, setUploading] = useState(false);
    const [rejectedFiles, setRejectedFiles] = useState<Array<{ originalName: string; reason: string }>>([]);
    const [dragActive, setDragActive] = useState(false);

    const fileInputRef = useRef<HTMLInputElement>(null);

    const resetState = () => {
        setPendingFiles([]);
        setDescription('');
        setDateVal('');
        setLocationQuery('');
        setLocationPlace(null);
        setTaggedPeople([]);
        setRejectedFiles([]);
    };

    const addFiles = (newFiles: FileList | File[]) => {
        const arr = Array.from(newFiles);
        setPendingFiles(prev => {
            const existing = new Set(prev.map(f => `${f.name}-${f.size}`));
            const deduped = arr.filter(f => !existing.has(`${f.name}-${f.size}`));
            return [...prev, ...deduped];
        });
    };

    const removeFile = (index: number) => {
        setPendingFiles(prev => prev.filter((_, i) => i !== index));
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setDragActive(false);
        if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
    };

    const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragActive(true); };
    const handleDragLeave = () => setDragActive(false);

    const handleUpload = async () => {
        if (pendingFiles.length === 0) return;
        setUploading(true);
        setRejectedFiles([]);

        try {
            const result = await uploadGalleryAssets(pendingFiles);

            const isoDate = dateVal.trim() ? parseToISO(dateVal.trim()) : null;
            const meta: Partial<AssetMetadata> = {
                ...(description.trim() && { description: description.trim() }),
                ...(isoDate && { date: isoDate }),
                ...(locationPlace
                    ? { location: locationPlace }
                    : locationQuery.trim()
                        ? { location: { name: locationQuery.trim() } as Place }
                        : {}),
            };
            const hasMeta = Object.keys(meta).length > 0;

            if (result.uploaded.length > 0 && hasMeta) {
                await Promise.all(result.uploaded.map(({ filename }) => updateAssetMeta(filename, meta)));
            }

            // Link people sequentially — concurrent writes to the same person's assets[]
            // cause a race condition where each request reads the pre-write list and
            // only the last write's file survives.
            if (result.uploaded.length > 0 && taggedPeople.length > 0) {
                for (const pid of taggedPeople) {
                    for (const { filename } of result.uploaded) {
                        await linkAssetToPerson(pid, filename);
                    }
                }
            }

            if (result.uploaded.length > 0) {
                onSuccess();
            }

            if (result.rejected.length > 0) {
                setRejectedFiles(result.rejected);
                toast.warning(`${result.uploaded.length} uploaded, ${result.rejected.length} rejected`);
            } else {
                const n = result.uploaded.length;
                toast.success(`${n} file${n === 1 ? '' : 's'} uploaded`);
                onOpenChange(false);
                resetState();
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Upload failed');
        } finally {
            setUploading(false);
        }
    };

    const handleClose = (nextOpen: boolean) => {
        if (!nextOpen) resetState();
        onOpenChange(nextOpen);
    };

    const displayFiles = pendingFiles.slice(0, 20);
    const ext = (f: File) => f.name.split('.').pop()?.toUpperCase() ?? 'FILE';

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="max-w-2xl flex flex-col gap-4 max-h-[90vh] overflow-hidden">
                <DialogHeader>
                    <DialogTitle>Upload Files</DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-3 overflow-y-auto flex-1 pr-1">
                    {/* Drop zone */}
                    <div
                        className={`rounded-lg border-2 border-dashed transition-colors cursor-pointer flex flex-col items-center justify-center gap-2 py-8 px-4 text-center ${
                            dragActive
                                ? 'border-primary bg-primary/5'
                                : 'border-border hover:border-primary/50 hover:bg-muted/30'
                        }`}
                        onDrop={handleDrop}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onClick={() => fileInputRef.current?.click()}
                    >
                        <Upload className="h-8 w-8 text-muted-foreground" />
                        <div>
                            <p className="text-sm font-medium">Drop files here or click to browse</p>
                            <p className="text-xs text-muted-foreground mt-0.5">Images, PDF, TXT, MD — up to 50 MB each</p>
                        </div>
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            accept="image/*,.pdf,.txt,.md"
                            className="hidden"
                            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
                        />
                    </div>

                    {/* File preview list */}
                    {pendingFiles.length > 0 && (
                        <div className="space-y-1.5">
                            {displayFiles.map((file, i) => {
                                return (
                                    <div key={`${file.name}-${file.size}-${i}`} className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2">
                                        <FileThumbnail file={file} />
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-medium truncate">{file.name}</p>
                                            <Badge variant="secondary" className="text-[9px] px-1 py-0">{ext(file)}</Badge>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                                            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                );
                            })}
                            {pendingFiles.length > 20 && (
                                <p className="text-xs text-muted-foreground text-center">
                                    …and {pendingFiles.length - 20} more
                                </p>
                            )}
                        </div>
                    )}

                    {/* Metadata section */}
                    {pendingFiles.length > 0 && (
                        <div className="rounded-md border border-border bg-muted/20 p-3 space-y-3">
                            <p className="text-xs text-muted-foreground">
                                These settings will apply to all {pendingFiles.length} {pendingFiles.length === 1 ? 'file' : 'files'}
                            </p>

                            {/* People — first, most commonly used */}
                            <div>
                                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">People</p>
                                {taggedPeople.length > 0 && (
                                    <div className="flex flex-wrap gap-1 mb-2">
                                        {taggedPeople.map((pid) => (
                                            <div key={pid} className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                                                <PersonChip id={pid} className="text-xs" />
                                                <button
                                                    type="button"
                                                    onClick={() => setTaggedPeople(prev => prev.filter(p => p !== pid))}
                                                    className="p-0.5 rounded-full text-muted-foreground hover:text-destructive transition-colors"
                                                >
                                                    <X className="h-2.5 w-2.5" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <PersonSearchCombobox
                                    onSelect={(pid) => setTaggedPeople(prev => prev.includes(pid) ? prev : [...prev, pid])}
                                    excludeIds={taggedPeople}
                                    placeholder="Tag a person…"
                                    className="w-full"
                                />
                            </div>

                            {/* Location */}
                            <div>
                                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Location</p>
                                <PlaceSearchCombobox
                                    value={locationQuery}
                                    onChange={(q) => { setLocationQuery(q); setLocationPlace(null); }}
                                    onSelect={(p) => setLocationPlace(p)}
                                    inputClassName="h-7 text-xs"
                                    size="sm"
                                />
                            </div>

                            {/* Date */}
                            <div>
                                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Date</p>
                                <SmartDateInput
                                    value={dateVal}
                                    onChange={setDateVal}
                                    placeholder="e.g. Jun 1950"
                                    className="h-7 text-xs"
                                />
                            </div>

                            {/* Description */}
                            <div>
                                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Description</p>
                                <textarea
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    placeholder="Add a description…"
                                    className="w-full text-xs rounded-md border border-input bg-background px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                                    rows={2}
                                />
                            </div>
                        </div>
                    )}

                    {/* Rejected files */}
                    {rejectedFiles.length > 0 && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-1">
                            <p className="text-xs font-semibold text-destructive">Rejected files:</p>
                            {rejectedFiles.map((r, i) => (
                                <p key={i} className="text-xs text-muted-foreground">
                                    <span className="font-mono">{r.originalName}</span> — {r.reason}
                                </p>
                            ))}
                        </div>
                    )}
                </div>

                <DialogFooter className="shrink-0">
                    <Button variant="outline" onClick={() => handleClose(false)} disabled={uploading}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleUpload}
                        disabled={uploading || pendingFiles.length === 0}
                    >
                        {uploading ? (
                            <>
                                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                Uploading…
                            </>
                        ) : (
                            <>
                                <Upload className="h-3.5 w-3.5 mr-1.5" />
                                Upload ({pendingFiles.length} {pendingFiles.length === 1 ? 'file' : 'files'})
                            </>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** Image files get an object-URL preview, owned by this row: created on mount, revoked on unmount. */
function FileThumbnail({ file }: { file: File }) {
    const isImage = file.type.startsWith('image/');
    const [url, setUrl] = useState<string | null>(null);

    useEffect(() => {
        if (!isImage) return;
        const objectUrl = URL.createObjectURL(file);
        setUrl(objectUrl);
        return () => URL.revokeObjectURL(objectUrl);
    }, [file, isImage]);

    if (isImage && url) {
        return <img src={url} alt={file.name} className="h-10 w-10 rounded object-cover shrink-0" />;
    }
    return (
        <div className="h-10 w-10 rounded bg-muted flex items-center justify-center shrink-0">
            <FileText className="h-5 w-5 text-muted-foreground" />
        </div>
    );
}
