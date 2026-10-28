// PhotoPicker.tsx - take (or choose) a photo for one side of the card, with a preview.

// A picked photo plus a temporary URL the <img> preview can show.
export type Photo = { file: File; url: string };

type Props = {
  label: string;
  photo: Photo | null;
  onChange: (file: File | null) => void;
};

export function PhotoPicker({ label, photo, onChange }: Props) {
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

      {/* capture="environment" opens the rear camera directly at full resolution. */}
      <label className="button">
        {photo ? "Retake" : "Take photo"}
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
