import {NetworkStatus} from './call';
import {TinyEmitter} from 'tiny-emitter';
import NetInfo from '@react-native-community/netinfo';

export class RNCheckNetworkStatus implements NetworkStatus {
  private emitter: TinyEmitter = new TinyEmitter();
  private timer?: any;
  private listener?: () => void;

  constructor() {}

  async isOnline<K extends {timeout: number}>(op: K): Promise<boolean> {
    NetInfo.configure({reachabilityRequestTimeout: op.timeout});
    const state = await NetInfo.fetch();
    return state.isInternetReachable || false;
  }

  on(_: 'change', _a: (isOnline: boolean) => any): void {
    this.listener = NetInfo.addEventListener((state) => {
      this.emitter.emit('change', state.isInternetReachable);
    });
  }

  off(_: 'change', _b: (isOnline: boolean) => any): void {
    this.listener?.();
  }
}
