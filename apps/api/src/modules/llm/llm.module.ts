import { Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { LlmProviderFactory } from './llm-provider.factory';
import { LlmModelsService } from './llm-models.service';

@Module({
  providers: [LlmService, LlmProviderFactory, LlmModelsService],
  exports: [LlmService, LlmModelsService],
})
export class LlmModule {}
