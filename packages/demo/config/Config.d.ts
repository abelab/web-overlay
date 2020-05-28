/* eslint-disable */
declare module "node-config-ts" {
  import { PortalManagerConfig } from "@web-overlay/manager/dist/portal";
  interface IConfig extends Partial<PortalManagerConfig> {
    KEY: string,
    INTRODUCER_URL?: string,
    OVERLAY?: "kirin" | "ddll",
    NO_CUI?: boolean
  }
  export const config: Config;
  export type Config = IConfig;
}
