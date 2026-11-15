import { Global, Module } from '@nestjs/common';
import { Clock } from './application/clock.port';
import { RealtimeEvents } from './application/realtime.port';
import { StudentLimitService } from './application/student-limit.service';
import { TimezoneClock } from './infrastructure/clock/timezone-clock';
import { SocketIoRealtimeEvents } from './infrastructure/realtime/socket-io-realtime-events';

@Global()
@Module({
  providers: [
    { provide: Clock, useClass: TimezoneClock },
    SocketIoRealtimeEvents,
    { provide: RealtimeEvents, useExisting: SocketIoRealtimeEvents },
    StudentLimitService,
  ],
  exports: [Clock, RealtimeEvents, SocketIoRealtimeEvents, StudentLimitService],
})
export class SharedModule {}
