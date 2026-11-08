import { Entity } from '../decorators';

export interface Auditable {
  touch(): void;
}

@Entity('users')
export class User implements Auditable {
  id!: string;
  email!: string;
  status: 'new' | 'active' | 'blocked' = 'new';
  touch(): void {
    this.status = 'active';
  }
}

export type UserSummary = Pick<User, 'id' | 'email'>;
