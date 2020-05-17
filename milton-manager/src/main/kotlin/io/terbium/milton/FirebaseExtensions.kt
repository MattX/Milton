package io.terbium.milton

import com.google.cloud.datastore.Entity
import com.google.cloud.datastore.FullEntity
import com.google.cloud.datastore.IncompleteKey
import java.time.Instant

object FirebaseExtensions {
    fun<K : IncompleteKey> FullEntity.Builder<K>.setNullableString(key: String, value: String?): FullEntity.Builder<K> {
        return apply {
            when (value) {
                null -> setNull(key)
                else -> set(key, value)
            }
        }
    }

    fun<K : IncompleteKey> FullEntity.Builder<K>.setNullableInstant(key: String, value: Instant?): FullEntity.Builder<K> =
            setNullableString(key, value?.toString())

    fun Entity.getNullableString(key: String): String? =
            if (isNull(key)) { null } else { getString(key) }

    fun Entity.getNullableInstant(key: String): Instant? =
            getNullableString(key)?.let { Instant.parse(it) }
}