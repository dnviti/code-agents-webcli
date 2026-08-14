/**
 * Facade for the message processor.
 *
 * The `MessageProcessor` class grew past one readable file, so it now lives as
 * a linear chain of abstract partial classes (one cohesive concern each) in the
 * `messages-*.ts` siblings below, ending in the concrete class here. This module
 * is kept as the original path so every existing importer and test keeps working
 * unchanged.
 */
export * from './messages/messages-types.js';
export { MessageProcessor } from './messages/messages-concrete.js';
