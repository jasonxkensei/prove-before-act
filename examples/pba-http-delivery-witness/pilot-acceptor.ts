import { PilotRecipientStore } from "./pilot-store";

const storeDir = process.env.PBA_WITNESS_STORE_DIR;
if (!storeDir) throw new Error("PBA_WITNESS_STORE_DIR is required");

const store = new PilotRecipientStore(storeDir);
export const nonceStore = store;
export const acceptDelivery = store.acceptDelivery.bind(store);