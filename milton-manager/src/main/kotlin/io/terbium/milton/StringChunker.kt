package io.terbium.milton

class StringChunker(private val chunkSize: Int) {
    fun chunkString(s: String): List<String> {
        val parts = s.split('\n')
                .map { it.trim() }
                .filter { !it.isBlank() }
                .flatMap { chunkWords(it) }
        println(parts)
        return accumulate(parts.asSequence(), '\n')
    }

    private fun chunkWords(s: String): List<String> {
        val words = s.split("\\s+".toRegex())
        return accumulate(words.asSequence(), ' ')
    }

    private fun accumulate(parts: Sequence<String>, sep: Char): List<String> {
        val chunks: MutableList<String> = mutableListOf()
        var currentChunk = mutableListOf<String>()
        var currentSize = 0

        for (part in parts) {
            val partLen = part.length
            if (currentSize + partLen + 1 > chunkSize) {
                chunks.add(currentChunk.joinToString(sep.toString()))
                currentChunk = mutableListOf(part)
                currentSize = partLen
            } else {
                currentChunk.add(part)
                currentSize += partLen + 1
            }
        }

        if (currentSize > 0) {
            chunks.add(currentChunk.joinToString(sep.toString()))
        }

        return chunks
    }
}