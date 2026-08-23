export default function SqlPreview({ sql }: { sql: string }) {
  return (
    <details className="sql-preview">
      <summary>SQL sent</summary>
      <pre>{sql}</pre>
    </details>
  );
}
