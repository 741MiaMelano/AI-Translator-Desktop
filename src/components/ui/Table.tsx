import type { ReactNode } from "react";

interface TableProps {
  headers: string[];
  rows: ReactNode[][];
}

export default function Table({ headers, rows }: TableProps) {
  return (
    <div className="overflow-x-auto rounded-[6px] border border-line">
      <table className="w-full border-collapse text-left text-[13px]">
        <thead className="bg-card-soft text-[11.5px] text-[var(--color-text-muted)]">
          <tr>
            {headers.map((header) => (
              <th key={header} className="whitespace-nowrap px-3 py-2 font-medium">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)] bg-card">
          {rows.map((row, index) => (
            <tr key={index} className="transition hover:bg-card-soft">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-3 py-2 align-middle">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
