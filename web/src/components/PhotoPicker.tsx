// PhotoPicker.tsx - scan, take, or choose a photo for one side of the card, with a preview.

// A picked photo plus a temporary URL the <img> preview can show.
export type Photo = { file: File; url: string };

type Props = {
  label: string;
  photo: Photo | null;
  onChange: (file: File | null) => void;
  onScan: () => void;
  scanDisabled: boolean; // e.g. while OpenCV is still loading
};

export function PhotoPicker({ label, photo, onChange, onScan, scanDisabled }: Props) {
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.files?.[0] ?? null);
    e.target.value = ""; // so picking the same file again still fires onChange
  };

  return (
    <div className="picker">
      <h3>{label}</h3>
      {photo ? (
        <img className="preview" src={photo.url} alt={`${label} preview`} />
      ) : (
        <div className="preview empty">No photo yet</div>
      )}

      {/* Live camera that captures automatically once the card is in frame. */}
      <button className="button scan" onClick={onScan} disabled={scanDisabled}>
        {photo ? "Rescan" : "Scan card"}
      </button>

      {/* capture="environment" opens the native camera app at full resolution. */}
      <label className="button">
        {photo ? "Retake photo" : "Take photo"}
        <input type="file" accept="image/*" capture="environment" onChange={handleFile} hidden />
      </label>

      {/* Same input without capture = photo library. Handy for testing old photos. */}
      <label className="link">
        or choose from Photos
        <input type="file" accept="image/*" onChange={handleFile} hidden />
      </label>

      {photo && (
        <button className="link" onClick={() => onChange(null)}>
          Remove
        </button>
      )}
    </div>
  );
}
