export function SearchBar({
  value,
  onChange,
  placeholder = "Search by name, view or workspace",
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="searchbar">
      <span className="searchbar-glyph" aria-hidden="true">
        ⌕
      </span>
      <input
        type="search"
        className="searchbar-input"
        value={value}
        placeholder={placeholder}
        aria-label="Search"
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button
          type="button"
          className="searchbar-clear"
          aria-label="Clear search"
          onClick={() => onChange("")}
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}
