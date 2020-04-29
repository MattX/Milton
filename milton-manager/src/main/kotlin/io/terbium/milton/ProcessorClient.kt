package io.terbium.milton

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.features.HttpTimeout
import io.ktor.client.features.json.GsonSerializer
import io.ktor.client.features.json.JsonFeature
import io.ktor.client.request.post

class ProcessorClient(processorHost: String, private val preprocessorSecret: String) {
    private val processorUrl = "$processorHost/extract"
    private val json = io.ktor.client.features.json.defaultSerializer()
    private val httpClient = HttpClient(OkHttp) {
        install(JsonFeature) {
            serializer = GsonSerializer {
                serializeNulls()
            }
        }
        install(HttpTimeout) {
            requestTimeoutMillis = 15_000
            socketTimeoutMillis = 15_000
        }
    }

    suspend fun process(content: String): ProcessedPage {
        return httpClient.post<ProcessorOutput>(processorUrl) {
            body = json.write(ProcessorInput(preprocessorSecret, content))
        }.toProcessedPage()
    }

    private data class ProcessorInput(
        val secret: String,
        val page: String
    )

    private data class ProcessorOutput(
        val title: String,
        val byline: String?,
        val dir: String?,
        val content: String,
        val textContent: String,
        val length: Long,
        val siteName: String?
    ) {
        fun toProcessedPage() = ProcessedPage(
                title = title,
                byline = byline,
                content = content,
                textContent = textContent,
                siteName = siteName
        )
    }

    data class ProcessedPage(
            val title: String,
            val byline: String?,
            val content: String,
            val textContent: String,
            val siteName: String?
    )
}
