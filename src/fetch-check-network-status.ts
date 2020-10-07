import { TinyEmitter } from "tiny-emitter";
import log from "./log";
import { NetworkStatus } from "./call";

export class FetchCheckNetworkStatus implements NetworkStatus {
  private emitter: TinyEmitter = new TinyEmitter();
  private timer?: any;

  constructor() {
    window.addEventListener("offline", () => this.offlineListener());
    window.addEventListener("online", () => this.offlineListener());
  }

  isOnline<K extends { timeout: number }>(op: K): Promise<boolean> {
    // This way we check the browser support: navigator.onLine === false
    // It only checks the network status it's does not care if you have
    // internet access.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>(async (f) => {
      let controller: any = null;
      let supportAbort = typeof AbortController !== "undefined";
      let cancelled = false;
      const options: RequestInit = {
        method: "HEAD",
        cache: "no-cache",
        mode: "no-cors",
      };

      if (supportAbort) {
        controller = new AbortController();
        options.signal = controller.signal;
      }

      const promise = Promise.race([
        fetch("https://captive.apple.com/hotspot-detect.html", options),
        fetch("https://www.google.com", options),
      ]);

      const timer = setTimeout(() => {
        cancelled = true;
        f(false);
      }, op.timeout);

      const resolverPromise = (result: boolean) => {
        if (supportAbort) {
          controller.abort();
        }

        if (cancelled) {
          return;
        }

        clearTimeout(timer);
        f(result);
      };

      try {
        await promise;
        resolverPromise(true);
      } catch (e) {
        log.error("error while checking the internet connection:", e);
        resolverPromise(false);
      }
    });
  }

  on(type: "change", cb: (isOnline: boolean) => any): void {
    this.emitter.on("change", cb);
  }

  off(type: "change", cb: (isOnline: boolean) => any): void {
    this.emitter.on("change", cb);
  }

  private async offlineListener() {
    const result = await this.isOnline({ timeout: 3000 });
    this.emitter.emit("change", result);

    if (result) {
      return;
    }

    if (this.timer) {
      return;
    }

    this.timer = setTimeout(async () => {
      const newResult = await this.isOnline({ timeout: 2900 });

      if (newResult) {
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = undefined;
        }

        this.emitter.emit("change", newResult);
      }
    }, 3000);
  }
}
