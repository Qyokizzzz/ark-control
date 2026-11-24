import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { NavLink } from 'react-router';
import { Badge, Box, IconButton, List, ListItemButton, Typography } from '@mui/material';
import { DotsSixVerticalIcon } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

interface NavigationItem {
  path: string;
  label: string;
  icon: Icon;
}

interface Drag {
  pointerId: number;
  from: string;
  startY: number;
  y: number;
  moved: boolean;
  frame: number;
  scrollParent: HTMLElement | null;
}

export default function SidebarNavigation({
  items,
  currentPath,
  errors,
  onNavigate,
  onMove,
}: {
  items: NavigationItem[];
  currentPath: string;
  errors: number;
  onNavigate: () => void;
  onMove: (from: string, to: string) => void;
}) {
  const { t } = useTranslation();
  const list = useRef<HTMLUListElement>(null);
  const drag = useRef<Drag | null>(null);
  const [drop, setDrop] = useState<{ from: string; to: string } | null>(null);

  const targetAt = useCallback((y: number) => {
    let target: string | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    for (const row of Array.from(list.current?.children ?? []) as HTMLElement[]) {
      const bounds = row.getBoundingClientRect();
      const distance = Math.abs(y - (bounds.top + bounds.height / 2));
      if (row.dataset.path && distance < nearest) {
        nearest = distance;
        target = row.dataset.path;
      }
    }
    return target;
  }, []);
  const updateDrop = useCallback(
    (gesture: Drag) => {
      const to = targetAt(gesture.y) ?? gesture.from;
      setDrop((current) =>
        current?.from === gesture.from && current.to === to ? current : { from: gesture.from, to },
      );
    },
    [targetAt],
  );
  const scrollWhileDragging = useCallback(
    function frame() {
      const gesture = drag.current;
      if (!gesture?.moved) return;
      const parent = gesture.scrollParent;
      if (parent) {
        const { top, bottom } = parent.getBoundingClientRect();
        const step = gesture.y < top + 36 ? -10 : gesture.y > bottom - 36 ? 10 : 0;
        const previous = parent.scrollTop;
        parent.scrollTop += step;
        if (parent.scrollTop !== previous) updateDrop(gesture);
      }
      gesture.frame = requestAnimationFrame(frame);
    },
    [updateDrop],
  );

  useEffect(
    () => () => {
      if (drag.current) cancelAnimationFrame(drag.current.frame);
      drag.current = null;
    },
    [],
  );

  const clearDrag = useCallback(() => {
    if (drag.current) cancelAnimationFrame(drag.current.frame);
    drag.current = null;
    setDrop(null);
  }, []);
  const handleGrab = useCallback((event: PointerEvent<HTMLButtonElement>, path: string) => {
    if (!event.isPrimary || event.button !== 0 || drag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      from: path,
      startY: event.clientY,
      y: event.clientY,
      moved: false,
      frame: 0,
      scrollParent: event.currentTarget.closest('.MuiDrawer-paper'),
    };
  }, []);
  const handleDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const gesture = drag.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gesture.y = event.clientY;
      if (!gesture.moved) {
        if (Math.abs(gesture.y - gesture.startY) < 6) return;
        gesture.moved = true;
        gesture.frame = requestAnimationFrame(scrollWhileDragging);
      }
      updateDrop(gesture);
    },
    [scrollWhileDragging, updateDrop],
  );
  const handleDrop = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const gesture = drag.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const target = gesture.moved ? targetAt(event.clientY) : undefined;
      clearDrag();
      if (target && target !== gesture.from) onMove(gesture.from, target);
    },
    [clearDrag, onMove, targetAt],
  );
  const handlePointerCancel = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (drag.current?.pointerId === event.pointerId) clearDrag();
    },
    [clearDrag],
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key === 'Escape' && drag.current) {
        clearDrag();
        return;
      }
      if (drag.current || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      event.preventDefault();
      const destination = items[index + (event.key === 'ArrowUp' ? -1 : 1)];
      if (destination) onMove(items[index]!.path, destination.path);
    },
    [clearDrag, items, onMove],
  );
  const fromIndex = items.findIndex(({ path }) => path === drop?.from);

  return (
    <List ref={list} disablePadding aria-label={t('目录')}>
      {items.map(({ path, label, icon: Icon }, index) => {
        const dropHere = drop?.to === path && drop.from !== path;
        return (
          <Box
            component="li"
            key={path}
            data-path={path}
            sx={{
              display: 'flex',
              alignItems: 'center',
              mb: 0.5,
              borderRadius: 2,
              position: 'relative',
              bgcolor: drop?.from === path ? 'action.selected' : undefined,
              ...(dropHere && {
                '&::after': {
                  content: '""',
                  position: 'absolute',
                  insetInline: 0,
                  ...(index < fromIndex ? { top: -2 } : { bottom: -2 }),
                  height: 2,
                  bgcolor: 'primary.main',
                  borderRadius: 1,
                  pointerEvents: 'none',
                },
              }),
            }}
          >
            <ListItemButton
              component={NavLink}
              to={path}
              end={path === '/'}
              onClick={onNavigate}
              sx={{
                minWidth: 0,
                px: 1.5,
                py: 1.5,
                borderRadius: 2,
                gap: 1.5,
                color: 'text.secondary',
                '&.active': { bgcolor: 'action.selected', color: 'primary.main', fontWeight: 500 },
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <Icon size={20} weight={currentPath === path ? 'duotone' : 'regular'} />
              <Typography noWrap sx={{ fontWeight: 'inherit' }}>
                {t(label)}
              </Typography>
              {path === '/logs' && errors > 0 && (
                <Badge color="error" badgeContent={errors} sx={{ ml: 'auto', mr: 0.5 }} />
              )}
            </ListItemButton>
            <IconButton
              size="small"
              disableRipple
              aria-label={`${t('拖动排序')} ${t(label)}`}
              title={t('拖动或按上下方向键调整顺序')}
              onPointerDown={(event) => handleGrab(event, path)}
              onPointerMove={handleDrag}
              onPointerUp={handleDrop}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={handlePointerCancel}
              onKeyDown={(event) => handleKeyDown(event, index)}
              sx={{
                flex: '0 0 32px',
                height: 36,
                borderRadius: 1,
                color: 'text.secondary',
                touchAction: 'none',
                cursor: drop?.from === path ? 'grabbing' : 'grab',
                '&:focus-visible': {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  outlineOffset: -2,
                },
              }}
            >
              <DotsSixVerticalIcon size={18} aria-hidden />
            </IconButton>
          </Box>
        );
      })}
    </List>
  );
}
