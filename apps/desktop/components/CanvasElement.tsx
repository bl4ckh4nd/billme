
import React, { useRef, useState, useEffect } from 'react';
import { InvoiceElement, ElementType, SnapGuide } from '../types';
import { GripHorizontal, Trash2, QrCode } from 'lucide-react';
import { A4_WIDTH_PX, A4_HEIGHT_PX, DIN_ZONES } from '../constants';
import { renderTextWithPlaceholders } from '../utils/placeholders';

interface CanvasElementProps {
  element: InvoiceElement;
  elements: InvoiceElement[];
  isSelected: boolean;
  onSelect?: (id: string) => void;
  onUpdate?: (id: string, updates: Partial<InvoiceElement>) => void;
  onDelete?: (id: string) => void;
  onSnap?: (guides: SnapGuide[]) => void;
  scale: number;
  readOnly?: boolean;
}

export const CanvasElement: React.FC<CanvasElementProps> = ({
  element,
  elements,
  isSelected,
  onSelect = () => {},
  onUpdate,
  onDelete,
  onSnap,
  scale,
  readOnly = false
}) => {
  const nodeRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isInlineEditing, setIsInlineEditing] = useState(false); // For double-click edit
  
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const elemStartRef = useRef<{ x: number; y: number } | null>(null);
  const siblingsRef = useRef<InvoiceElement[]>([]);
  const dimensionsRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });

  // Handle global mouse events for dragging
  useEffect(() => {
    if (readOnly || isInlineEditing) return;
    
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging || !dragStartRef.current || !elemStartRef.current || !onUpdate || !onSnap) return;

      const deltaX = (e.clientX - dragStartRef.current.x) / scale;
      const deltaY = (e.clientY - dragStartRef.current.y) / scale;

      let proposedX = elemStartRef.current.x + deltaX;
      let proposedY = elemStartRef.current.y + deltaY;

      // Snapping Logic
      const threshold = 5;
      const guides: SnapGuide[] = [];
      const w = dimensionsRef.current.width;
      const h = dimensionsRef.current.height;

      // Targets: Siblings AND DIN Zones
      // DIN Zones usually snap top-left or top-right, but mostly position (x,y)
      
      const xTargets = [0, A4_WIDTH_PX];
      const yTargets = [0, A4_HEIGHT_PX];

      // Add DIN Zones to targets
      DIN_ZONES.forEach(zone => {
          xTargets.push(zone.x);
          yTargets.push(zone.y);
          // Optional: Snap to right/bottom of zones if needed
      });

      siblingsRef.current.forEach(sib => {
        xTargets.push(sib.x); 
        if (sib.style.width) {
            xTargets.push(sib.x + sib.style.width / 2);
            xTargets.push(sib.x + sib.style.width);
        }
        yTargets.push(sib.y);
        if (sib.style.height) {
            yTargets.push(sib.y + sib.style.height / 2);
            yTargets.push(sib.y + sib.style.height);
        }
      });

      // --- Vertical Snapping (X-axis) ---
      let bestDX = Infinity;
      let snapX = null;
      let snapGuideX = null;

      // Edges of current element to align
      const myXEdges = [0, w/2, w];

      xTargets.forEach(target => {
        myXEdges.forEach(edgeOffset => {
            const currentEdgePos = proposedX + edgeOffset;
            const diff = target - currentEdgePos;
            if (Math.abs(diff) < threshold && Math.abs(diff) < Math.abs(bestDX)) {
                bestDX = diff;
                snapX = target - edgeOffset;
                snapGuideX = target;
            }
        });
      });

      if (snapX !== null && Math.abs(bestDX) <= threshold) {
          proposedX = snapX;
          if (snapGuideX !== null) {
              guides.push({ orientation: 'vertical', position: snapGuideX });
          }
      }

      // --- Horizontal Snapping (Y-axis) ---
      let bestDY = Infinity;
      let snapY = null;
      let snapGuideY = null;
      
      const myYEdges = [0, h/2, h];

      yTargets.forEach(target => {
        myYEdges.forEach(edgeOffset => {
            const currentEdgePos = proposedY + edgeOffset;
            const diff = target - currentEdgePos;
            if (Math.abs(diff) < threshold && Math.abs(diff) < Math.abs(bestDY)) {
                bestDY = diff;
                snapY = target - edgeOffset;
                snapGuideY = target;
            }
        });
      });

      if (snapY !== null && Math.abs(bestDY) <= threshold) {
          proposedY = snapY;
          if (snapGuideY !== null) {
              guides.push({ orientation: 'horizontal', position: snapGuideY });
          }
      }

      onSnap(guides);

      onUpdate(element.id, {
        x: proposedX,
        y: proposedY
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
      elemStartRef.current = null;
      if (onSnap) onSnap([]); 
    };

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, element.id, onUpdate, scale, onSnap, readOnly, isInlineEditing]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (readOnly || isInlineEditing) return;
    e.stopPropagation();
    if (onSelect) onSelect(element.id);
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    elemStartRef.current = { x: element.x, y: element.y };

    siblingsRef.current = elements.filter(el => el.id !== element.id);
    if (nodeRef.current) {
        dimensionsRef.current = {
            width: nodeRef.current.offsetWidth,
            height: nodeRef.current.offsetHeight
        };
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (readOnly || element.type !== ElementType.TEXT) return;
    e.stopPropagation();
    setIsInlineEditing(true);
    setIsDragging(false);
  };

  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
      setIsInlineEditing(false);
      if (onUpdate && e.currentTarget.textContent !== element.content) {
          onUpdate(element.id, { content: e.currentTarget.textContent || '' });
      }
  };

  const commonStyle: React.CSSProperties = {
    position: 'absolute',
    left: `${element.x}px`,
    top: `${element.y}px`,
    width: element.style.width ? `${element.style.width}px` : 'auto',
    height: element.style.height ? `${element.style.height}px` : 'auto',
    fontSize: `${element.style.fontSize}px`,
    fontWeight: element.style.fontWeight || 'normal',
    textAlign: element.style.textAlign || 'left',
    color: element.style.color || '#000',
    backgroundColor: element.style.backgroundColor || 'transparent',
    fontFamily: element.style.fontFamily || 'Inter, sans-serif',
    textDecoration: element.style.textDecoration || 'none',
    outline: isSelected && !readOnly ? '2px solid var(--color-accent)' : '1px solid transparent',
    boxShadow: isSelected && !readOnly ? '0 0 0 1px rgba(0,0,0,0.1)' : 'none',
    cursor: readOnly ? 'default' : (isDragging ? 'grabbing' : isInlineEditing ? 'text' : 'pointer'),
    padding: element.type === ElementType.TEXT ? '4px' : '0',
    userSelect: isInlineEditing ? 'text' : 'none',
    zIndex: element.zIndex,
  };

  const renderContent = () => {
    switch (element.type) {
      case ElementType.TEXT:
        // Use Smart Rendering with Pills unless we are inline editing (then raw text)
        // If readOnly (Preview Mode), content is already replaced by the parent component logic, so renderTextWithPlaceholders will just see normal text
        if (isInlineEditing) {
            return (
                <div 
                    contentEditable
                    onBlur={handleBlur}
                    suppressContentEditableWarning
                    className="w-full h-full outline-none"
                    style={{ whiteSpace: 'pre-wrap', cursor: 'text' }}
                >
                    {element.content || 'Neuer Text'}
                </div>
            );
        } else {
             return (
                <div className="w-full h-full" style={{ whiteSpace: 'pre-wrap' }}>
                    {renderTextWithPlaceholders(element.content || '') || 'Neuer Text'}
                </div>
            );
        }
      case ElementType.IMAGE:
        return (
          <img
            src={element.src || 'https://picsum.photos/200/100'}
            alt="Element"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            draggable={false}
          />
        );
      case ElementType.BOX:
        return <div style={{ width: '100%', height: '100%', backgroundColor: element.style.backgroundColor || '#eee' }} />;
      case ElementType.LINE:
        return <div style={{ width: '100%', height: '100%', backgroundColor: element.style.backgroundColor || '#000' }} />;
      case ElementType.QRCODE:
        return (
            <div className="w-full h-full bg-white flex flex-col items-center justify-center border-2 border-black relative overflow-hidden">
                {/* Simulated QR Code Pattern */}
                <div className="absolute inset-2 grid grid-cols-4 grid-rows-4 gap-1 opacity-80">
                    <div className="bg-black col-span-2 row-span-2"></div>
                    <div className="bg-black col-span-1 row-start-1 col-start-4"></div>
                    <div className="bg-black col-span-1 row-start-4 col-start-1"></div>
                    <div className="bg-black col-span-2 row-span-2 row-start-3 col-start-3"></div>
                </div>
                <div className="z-10 bg-white px-2 py-1 text-[8px] font-bold border border-black">
                    GIROCODE
                </div>
            </div>
        );
      case ElementType.TABLE:
        // Use visible columns from data, default to basic if not present
        const columns = element.tableData?.columns || [];
        
        return (
          <table className="w-full border-collapse" style={{ tableLayout: 'fixed' }}>
            <thead>
              <tr>
                {columns.map((col, i) => {
                    if (!col.visible) return null;
                    return (
                         <th key={col.id} style={{ width: `${col.width}px`, textAlign: col.align || 'left' }} className="border-b-2 border-black/10 p-2 bg-gray-50 text-xs font-bold uppercase tracking-wide text-gray-500 truncate">
                             {col.label}
                         </th>
                    );
                })}
              </tr>
            </thead>
            <tbody>
              {element.tableData?.rows.map((row) => (
                <tr key={row.id} className="border-b border-gray-100">
                  {columns.map((col, i) => {
                      if (!col.visible) return null;
                      // Mapping assumption: row.cells index matches columns index in master list
                      return (
                          <td key={`${row.id}-${col.id}`} style={{ textAlign: col.align || 'left' }} className="p-2 truncate">
                              {row.cells[i]}
                          </td>
                      );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        );
      default:
        return null;
    }
  };

  return (
    <div
      ref={nodeRef}
      style={commonStyle}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      className="group"
    >
      {isSelected && !readOnly && !isInlineEditing && onDelete && (
        <div className="absolute -top-10 left-0 bg-black text-accent rounded-lg flex items-center shadow-xl px-3 py-1.5 space-x-3 no-print z-[9999] transform -translate-x-1">
          <GripHorizontal size={16} />
          <div className="w-px h-4 bg-[#333]"></div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(element.id);
            }}
            className="hover:text-white transition-colors"
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}
      {renderContent()}
    </div>
  );
};
