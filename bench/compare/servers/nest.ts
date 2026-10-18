// NestJS on the Fastify platform: controllers, class-validator DTO through ValidationPipe,
// a CanActivate guard for /secure, React renderToString for /page.
import "reflect-metadata";
import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Header,
  Injectable,
  Module,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
  ValidationPipe,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { IsNotEmpty, IsNumber, IsString } from "class-validator";
import { renderPage } from "./react-page.js";
import { BEARER, HOST, PORT } from "./shared.js";

class EchoDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsNumber()
  age!: number;
}

@Injectable()
class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    if (request.headers.authorization !== BEARER) throw new UnauthorizedException();
    return true;
  }
}

@Controller()
class BenchController {
  @Get("json")
  json() {
    return { hello: "world" };
  }

  @Get("users/:id")
  user(@Param("id", ParseIntPipe) id: number, @Query("fields") fields?: string) {
    return { id, fields: fields ? fields.split(",") : [] };
  }

  @Post("echo")
  echo(@Body() input: EchoDto) {
    return { ok: true, name: input.name, age: input.age };
  }

  @Get("secure")
  @UseGuards(AuthGuard)
  secure() {
    return { ok: true, user: "bench" };
  }

  @Get("page")
  @Header("content-type", "text/html; charset=utf-8")
  page() {
    return renderPage();
  }
}

@Module({ controllers: [BenchController], providers: [AuthGuard] })
class AppModule {}

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
app.useGlobalPipes(new ValidationPipe());
await app.listen(PORT, HOST);
console.log("ready");
