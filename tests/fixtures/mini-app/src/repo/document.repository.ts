import { Injectable } from '../decorators';
import { User } from '../domain/user';
import { UserRepository } from './user.repository';

@Injectable()
export class DocumentUserRepository extends UserRepository {
  private readonly docs: User[] = [];

  async findById(id: string): Promise<User | null> {
    return this.docs.find((d) => d.id === id) ?? null;
  }

  async save(user: User): Promise<User> {
    this.docs.push(user);
    return user;
  }
}
