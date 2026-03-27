const primary = process.env.EXPO_PUBLIC_PRIMARY_COLOR || process.env.PRIMARY_COLOR || '#2E7D32'; // Green
const secondary = process.env.EXPO_PUBLIC_SECONDARY_COLOR || process.env.SECONDARY_COLOR || '#1B5E20'; // Dark Green

const Colors = {
  primary,
  primaryLight: '#E8F5E9', // Green 50
  primaryDark: '#1B5E20', // Green 900
  secondary,
  accent: '#FFC107',
  
  background: '#F8FAFB',
  surface: '#FFFFFF',
  surfaceAlt: '#F1F5F9',
  
  text: '#1A1D21',
  textSecondary: '#64748B',
  textMuted: '#94A3B8',
  
  border: '#E2E8F0',
  borderLight: '#F1F5F9',
  
  success: '#10B981',
  successLight: '#D1FAE5',
  warning: '#F59E0B',
  warningLight: '#FEF3C7',
  error: '#EF4444',
  errorLight: '#FEE2E2',
  info: '#2196F3',
  infoLight: '#E3F2FD',
  
  white: '#FFFFFF',
  black: '#000000',
  
  light: {
    text: '#1A1D21',
    background: '#F8FAFB',
    tint: primary,
    tabIconDefault: '#94A3B8',
    tabIconSelected: primary,
  },
};

export default Colors;
