import { StorageClient } from 'mini-sdk';
import axios from 'axios';
import { Injectable } from '../decorators';
import { User } from '../domain/user';
import { NotFoundException, ValidationException } from '../errors';
import { ConfigService, EventEmitter2 } from '../platform';
import { UserRepository } from '../repo/user.repository';
import { factorial } from '../util';

export interface ActivateDto {
  status: string;
  tags: string[];
}

@Injectable()
export class UsersService {
  constructor(
    private readonly repo: UserRepository,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  async findOne(id: string): Promise<User> {
    const user = await this.repo.findById(id);
    if (!user) {
      throw new NotFoundException('user not found');
    }
    return user;
  }

  async activate(id: string, dto: ActivateDto): Promise<string> {
    if (!id) return 'missing';
    dto.status = 'active';
    dto.tags.push('activated');
    const bucket = this.config.get('storage.bucket');
    const level = dto.status === 'active' ? 1 : 2;
    const user = await this.findOne(id);
    switch (user.status) {
      case 'new':
        user.touch();
        break;
      case 'blocked':
        throw new ValidationException('blocked');
      default:
        break;
    }
    try {
      const client = new StorageClient({ region: 'eu' });
      await client.putObject(`${bucket}/${id}`, 'x');
      await axios.post('https://hook.example', { id });
    } catch (e) {
      return 'failed';
    }
    for (const tag of dto.tags) {
      this.events.emit('user.tag', tag);
    }
    return `ok-${level}-${factorial(3)}`;
  }

  async register(user: User): Promise<User> {
    const saved = await this.repo.save(user);
    return saved;
  }
}
