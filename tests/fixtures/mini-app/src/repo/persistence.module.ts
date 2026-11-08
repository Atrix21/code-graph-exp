import { Module } from '../decorators';
import { UserRepository } from './user.repository';
import { RelationalUserRepository } from './relational.repository';
import { DocumentUserRepository } from './document.repository';

@Module({
  providers: [
    { provide: UserRepository, useClass: RelationalUserRepository },
    { provide: UserRepository, useClass: DocumentUserRepository },
  ],
})
export class PersistenceModule {}
