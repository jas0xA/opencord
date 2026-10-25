import { GATEWAY_PATH, GatewayOp, type GatewayPayload } from '@opencord/shared';

type State = 'connecting' | 'connected' | 'disconnected';

export class GatewayClient {
  private ws: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retry = 0;
  private closedByUser = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private acked = true;

  constructor(
    private base: string,
    private token: string,
    private onDispatch: (t: string, d: any) => void,
    private onState: (s: State) => void,
    private onSfu: (d: any) => void,
    private onAuthFailed: () => void,
  ) {}

  connect() {
    this.closedByUser = false;
    this.onState('connecting');
    const url = this.base.replace(/^http/, 'ws') + GATEWAY_PATH;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as GatewayPayload<any>;
      switch (msg.op) {
        case GatewayOp.HELLO:
          this.startHeartbeat(msg.d.heartbeat_interval);
          ws.send(JSON.stringify({ op: GatewayOp.IDENTIFY, d: { token: this.token } }));
          break;
        case GatewayOp.HEARTBEAT_ACK:
          this.acked = true;
          break;
        case GatewayOp.DISPATCH:
          if (msg.t === 'READY') {
            this.retry = 0;
            this.onState('connected');
          }
          this.onDispatch(msg.t!, msg.d);
          break;
        case GatewayOp.SFU:
          this.onSfu(msg.d);
          break;
      }
    };
    ws.onclose = (e) => {
      this.stopHeartbeat();
      if (this.ws !== ws) return;
      this.ws = null;
      if (e.code === 4004) {
        this.onAuthFailed();
        return;
      }
      if (this.closedByUser) return;
      this.onState('disconnected');
      const delay = Math.min(1000 * 2 ** this.retry, 30_000) + Math.random() * 1000;
      this.retry++;
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private startHeartbeat(interval: number) {
    this.stopHeartbeat();
    this.acked = true;
    this.heartbeat = setInterval(() => {
      if (!this.acked) {
        this.ws?.close(4000, 'Zombie connection');
        return;
      }
      this.acked = false;
      this.send(GatewayOp.HEARTBEAT, null);
    }, interval);
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  send(op: number, d: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }));
  }

  close() {
    this.closedByUser = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.stopHeartbeat();
    this.ws?.close(1000);
    this.ws = null;
  }
}
