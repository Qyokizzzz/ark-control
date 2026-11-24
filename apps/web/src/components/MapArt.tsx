import { Box } from '@mui/material';

export default function MapArt({ map, size = 56 }: { map: string; size?: number }) {
  const color =
    map === 'ScorchedEarth_P'
      ? '#d5b675'
      : map === 'Aberration_P'
        ? '#b4a0d9'
        : map === 'Extinction'
          ? '#c7a3a3'
          : '#9ac080';
  return (
    <Box
      component="svg"
      viewBox="0 0 80 80"
      aria-hidden="true"
      sx={{ width: size, height: size, flexShrink: 0, bgcolor: 'action.hover', borderRadius: 2 }}
    >
      <path d="M12 56 23 22 44 12 63 32 68 58 44 70 25 64Z" fill={color} opacity=".12" />
      <path
        d="M18 54 27 29 44 19 59 35 60 54 43 63 28 59ZM27 50 33 37 44 30 51 40 51 49 42 54Z"
        stroke={color}
        fill="none"
        strokeWidth="1"
        opacity=".6"
      />
      <path d="m30 51 12-25 11 25Z" fill={color} opacity=".8" />
      <path d="M36 46h12" stroke="#181818" strokeWidth="2" />
    </Box>
  );
}
