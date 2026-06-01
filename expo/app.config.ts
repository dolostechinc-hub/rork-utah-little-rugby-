import { ExpoConfig, ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  owner: 'tmcd23',
  name: 'Utah Little Rugby',
  slug: 'utah-little-rugby',
  version: '3.2.2',
  runtimeVersion: {
    policy: 'appVersion',
  },
  updates: {
    url: 'https://u.expo.dev/f7899347-aa05-47e8-91ef-49efdf33a996',
  },
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: 'utah-little-rugby',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  splash: {
    image: './assets/images/splash-icon.png',
    resizeMode: 'contain',
    backgroundColor: '#ffffff',
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.rosterupapp.app',
    buildNumber: '61',
    infoPlist: {
      NSPhotoLibraryUsageDescription:
        'Allow $(PRODUCT_NAME) to access your photos to add player profile pictures.',
      NSCameraUsageDescription:
        'Allow $(PRODUCT_NAME) to access your camera to take player profile pictures.',
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    versionCode: 18, 
    adaptiveIcon: {
      foregroundImage: './assets/images/adaptive-icon.png',
      backgroundColor: '#ffffff',
    },
    package: 'app.rork.utah.little.rugby.app',
    permissions: [
      'android.permission.CAMERA',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.VIBRATE',
    ],
  },
  web: {
    favicon: './assets/images/favicon.png',
  },
  plugins: [
    [
      'expo-router',
      {
        origin: 'https://rork.com/',
      },
    ],
    'expo-font',
    'expo-web-browser',
    [
      'expo-image-picker',
      {
        photosPermission:
          'The app accesses your photos to add player profile pictures.',
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    router: {
      origin: 'https://rork.com/',
    },
    eas: {
      projectId: 'f7899347-aa05-47e8-91ef-49efdf33a996',
    },
    EXPO_PUBLIC_SUPABASE_URL: 'https://pfhkypuavngiidyrrnpn.supabase.co',
    EXPO_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_o6d-VXD_hzD1AYntd2_guw_dj-8ZyYX',
    EXPO_PUBLIC_RORK_API_BASE_URL: process.env.EXPO_PUBLIC_RORK_API_BASE_URL,
    EXPO_PUBLIC_RORK_AUTH_URL: process.env.EXPO_PUBLIC_RORK_AUTH_URL,
    EXPO_PUBLIC_TOOLKIT_URL: process.env.EXPO_PUBLIC_TOOLKIT_URL,
    EXPO_PUBLIC_PROJECT_ID: process.env.EXPO_PUBLIC_PROJECT_ID,
    EXPO_PUBLIC_TEAM_ID: process.env.EXPO_PUBLIC_TEAM_ID,
    EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY:
      process.env.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY,
  },
});
