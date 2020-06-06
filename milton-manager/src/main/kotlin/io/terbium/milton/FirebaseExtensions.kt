/*
 * Copyright 2020 The Milton Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package io.terbium.milton

import com.google.cloud.datastore.Entity
import com.google.cloud.datastore.FullEntity
import com.google.cloud.datastore.IncompleteKey

object FirebaseExtensions {
    fun<K : IncompleteKey> FullEntity.Builder<K>.setNullableString(key: String, value: String?): FullEntity.Builder<K> {
        return apply {
            when (value) {
                null -> setNull(key)
                else -> set(key, value)
            }
        }
    }

    fun Entity.getNullableString(key: String): String? =
            if (isNull(key)) { null } else { getString(key) }
}
