import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { downloadCsv, exportToCsv } from '../lib/format.js';
import { EmptyState } from './EmptyState.js';

interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, any>[];
  searchPlaceholder?: string;
  exportFilename?: string;
  pageSize?: number;
  initialSorting?: SortingState;
  emptyTitle?: string;
  emptyDescription?: string;
  onRowClick?: (row: T) => void;
  renderSubRow?: (row: { original: T }) => ReactNode;
}

export function DataTable<T>({
  data,
  columns,
  searchPlaceholder = 'Search…',
  exportFilename = 'export.csv',
  pageSize = 10,
  initialSorting = [],
  emptyTitle = 'No data',
  emptyDescription,
  onRowClick,
  renderSubRow,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [globalFilter, setGlobalFilter] = useState('');
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  const exportRows = useMemo(() => {
    return table.getFilteredRowModel().rows.map((row) =>
      row.getVisibleCells().map((cell) => {
        const value = cell.getValue();
        return value == null ? '' : String(value);
      }),
    );
  }, [table]);

  const headers = table.getHeaderGroups()[0]?.headers.map((header) => String(header.column.columnDef.header ?? header.id)) ?? [];

  const handleExport = () => {
    const csv = exportToCsv(headers, exportRows);
    downloadCsv(exportFilename, csv);
  };

  if (data.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={globalFilter}
          onChange={(event) => setGlobalFilter(event.target.value)}
          placeholder={searchPlaceholder}
          className="min-w-[12rem] flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={handleExport}
          className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-bg"
        >
          Export CSV
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-bg/60">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="whitespace-nowrap px-3 py-2 text-left font-medium text-muted"
                  >
                    {header.isPlaceholder ? null : (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-ink"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {{
                          asc: ' ↑',
                          desc: ' ↓',
                        }[header.column.getIsSorted() as string] ?? null}
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-border bg-card">
            {table.getRowModel().rows.map((row) => (
              <Fragment key={row.id}>
                <tr
                  className={
                    onRowClick || renderSubRow ? 'cursor-pointer hover:bg-bg/60' : undefined
                  }
                  onClick={() => {
                    if (renderSubRow) {
                      setExpandedRows((current) => {
                        const next = new Set(current);
                        if (next.has(row.id)) next.delete(row.id);
                        else next.add(row.id);
                        return next;
                      });
                    }
                    if (onRowClick) onRowClick(row.original);
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="whitespace-nowrap px-3 py-2 text-ink">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
                {renderSubRow && expandedRows.has(row.id) ? (
                  <tr key={`${row.id}-detail`}>
                    <td colSpan={row.getVisibleCells().length} className="p-0">
                      {renderSubRow(row)}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
        <span>
          {table.getFilteredRowModel().rows.length} row(s)
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded border border-border px-2 py-1 disabled:opacity-40"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Previous
          </button>
          <span>
            Page {table.getState().pagination.pageIndex + 1} de {table.getPageCount() || 1}
          </span>
          <button
            type="button"
            className="rounded border border-border px-2 py-1 disabled:opacity-40"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
