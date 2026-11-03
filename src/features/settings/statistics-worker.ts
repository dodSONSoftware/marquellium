import { statistics } from "./statistics";
self.onmessage = (event: MessageEvent<string>) => self.postMessage(statistics(event.data));
