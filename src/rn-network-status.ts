import {TinyEmitter} from 'tiny-emitter';
import NetInfo, {NetInfoState} from '@react-native-community/netinfo';
import { NetworkStatus } from "./call";

export class RNCheckNetworkStatus implements NetworkStatus {
  private emitter: TinyEmitter = new TinyEmitter();
  private removeListener?: () => void;

  async isOnline<K extends {timeout: number}>(op: K): Promise<boolean> {
    NetInfo.configure({reachabilityRequestTimeout: op.timeout});
    const state = await NetInfo.fetch();
    return state.isInternetReachable || false;
  }

  on(_: 'change', _a: (isOnline: boolean) => any): void {
    this.removeListener = NetInfo.addEventListener((state: NetInfoState) => {
      this.emitter.emit('change', state.isInternetReachable);
    });
  }

  off(_: 'change', _b: (isOnline: boolean) => any): void {
    this.removeListener?.();
  }
}
