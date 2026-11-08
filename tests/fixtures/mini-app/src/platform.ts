export class ConfigService {
  get(key: string): string {
    return key;
  }
}
export class EventEmitter2 {
  emit(name: string, payload: unknown): boolean {
    void name; void payload;
    return true;
  }
}
