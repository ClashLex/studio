import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "cc.zoxilsi.studio",
  appName: "zoxilsi studio",
  webDir: "out",
  plugins: {
    SystemBars: {
      hidden: false,
      insetsHandling: "disable",
    },
  },
};

export default config;
