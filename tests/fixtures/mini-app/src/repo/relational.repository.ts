import { Injectable } from '../decorators';
import { User } from '../domain/user';
import { UserRepository } from './user.repository';

@Injectable()
export class RelationalUserRepository implements UserRepository {
  private readonly rows = new Map<string, User>();

  async findById(id: string): Promise<User | null> {
    return this.rows.get(id) ?? null;
  }

  async save(user: User): Promise<User> {
    this.rows.set(user.id, user);
    return user;
  }
}
