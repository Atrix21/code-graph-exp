import { Controller, Get, Post } from '../decorators';
import { User } from '../domain/user';
import { UsersService, ActivateDto } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(':id')
  async get(id: string): Promise<User> {
    return this.users.findOne(id);
  }

  @Post('activate')
  activate(id: string, dto: ActivateDto): Promise<string> {
    return this.users.activate(id, dto);
  }
}
